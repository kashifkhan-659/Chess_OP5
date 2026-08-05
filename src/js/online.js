// Online play: one Firebase Realtime Database room per game, no server of our
// own. The SDK is pulled from Google's ESM CDN on first use — this project has
// no bundler, and the AI/local modes never pay for a module they don't touch.
//
// A room is just the move list. Turn, board, check, mate and draw all fall out
// of replaying it through the same WASM engine on both devices, so nothing that
// the engine already knows gets duplicated into the database.
//
//   /rooms/{CODE}
//     createdAt: <epoch ms>
//     players:  { w: <playerId>, b: <playerId> }
//     moves:    { 0: {f,t,p?}, 1: {f,t,p?}, ... }
//     tc:       { id, base, inc }        — absent on an untimed room
//     clock:    { w: <ms>, b: <ms>, at: <epoch ms>, turn }
//     conn:     { w: true | <dropped at>, b: … }
//     over:     { winner, reason, at }   — only for endings the moves don't show
import { firebaseConfig } from './firebase-config.js';

const SDK = 'https://www.gstatic.com/firebasejs/12.17.1/';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0 or I/1 to misread
const SESSION_KEY = 'gambit:online';
const PLAYER_KEY = 'gambit:player';

export const onlineAvailable = Boolean(firebaseConfig);

// Room codes are the one thing a player types by hand, so log what we actually
// looked up when running off the dev server. Never in a build.
const DEV = typeof location !== 'undefined' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

let fb = null;

async function sdk() {
  if (fb) return fb;
  if (!firebaseConfig) throw new Error('Online play is not configured on this deployment.');
  const [app, database] = await Promise.all([
    import(`${SDK}firebase-app.js`),
    import(`${SDK}firebase-database.js`),
  ]);
  fb = { ...database, db: database.getDatabase(app.initializeApp(firebaseConfig)) };
  // Two clocks only agree if both devices measure against the same clock, and
  // neither of them is the one on the wall behind the player.
  database.onValue(database.ref(fb.db, '.info/serverTimeOffset'), (s) => {
    skew = s.val() || 0;
  });
  return fb;
}

let skew = 0;
/** Our best estimate of the server's clock. Every stored instant uses it. */
export const serverNow = () => Date.now() + skew;

// ------------------------------------------------------------------ storage

function store(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode: the room just won't survive a refresh */
  }
  return value;
}
function load(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

/** Stable per-browser identity. It's what lets a refresh reclaim its seat. */
let memoryId = null;
function playerId() {
  let id = load(PLAYER_KEY);
  if (typeof id !== 'string') {
    id = memoryId ||= crypto.randomUUID();
    store(PLAYER_KEY, id);
  }
  return id;
}

export const loadSession = () => load(SESSION_KEY);
export const clearSession = () => store(SESSION_KEY, null);

// ------------------------------------------------------------------- clocks

/** The presets the creator picks from, in the order the menu lists them. */
export const TIME_CONTROLS = [
  { id: 'none', group: 'Untimed', label: 'No clock' },
  { id: '1+0', group: 'Bullet', label: '1 min', base: 60, inc: 0 },
  { id: '1+1', group: 'Bullet', label: '1 min + 1 sec', base: 60, inc: 1 },
  { id: '3+0', group: 'Blitz', label: '3 min', base: 180, inc: 0 },
  { id: '3+2', group: 'Blitz', label: '3 min + 2 sec', base: 180, inc: 2 },
  { id: '5+0', group: 'Blitz', label: '5 min', base: 300, inc: 0 },
  { id: '10+0', group: 'Rapid', label: '10 min', base: 600, inc: 0 },
  { id: '10+5', group: 'Rapid', label: '10 min + 5 sec', base: 600, inc: 5 },
  { id: '15+10', group: 'Rapid', label: '15 min + 10 sec', base: 900, inc: 10 },
  { id: '30+0', group: 'Classical', label: '30 min', base: 1800, inc: 0 },
];

export const timeControl = (id) => TIME_CONTROLS.find((t) => t.id === id) || TIME_CONTROLS[0];

/**
 * Milliseconds left for `color` at `now`. Only the side to move is spending,
 * so every device can derive both clocks from the instant of the last move
 * rather than from its own countdown, which is what stops the two disagreeing.
 */
export function remaining(clock, color, now) {
  if (!clock) return 0;
  const left = clock[color];
  if (color !== clock.turn) return left;
  return Math.max(0, left - Math.max(0, now - clock.at));
}

/** The clock the side to move leaves behind by completing a move at `now`. */
export function afterMove(clock, inc, now) {
  const mover = clock.turn;
  return {
    w: clock.w,
    b: clock.b,
    [mover]: remaining(clock, mover, now) + inc * 1000,
    at: now,
    turn: mover === 'w' ? 'b' : 'w',
  };
}

/** Starts the clock once both seats are filled. Whoever gets there first wins. */
export async function startClock(code, tc) {
  const { db, ref, runTransaction } = await sdk();
  await runTransaction(ref(db, `rooms/${code}/clock`), (clock) =>
    clock ? undefined : { w: tc.base * 1000, b: tc.base * 1000, at: serverNow(), turn: 'w' }
  );
}

// -------------------------------------------------------------------- rooms

function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
}

export function normalizeCode(input) {
  return String(input || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Creates a room and seats the caller as White. Returns { code, color }. */
export async function createRoom(tcId) {
  const { db, ref, runTransaction } = await sdk();
  const id = playerId();
  const tc = timeControl(tcId);
  const fresh = { createdAt: Date.now(), players: { w: id } };
  if (tc.base) fresh.tc = { id: tc.id, base: tc.base, inc: tc.inc };
  // A collision needs two of 32^6 codes to land together; retry rather than
  // ever hand a player a room somebody else is already sitting in.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode();
    const res = await runTransaction(ref(db, `rooms/${code}`), (room) => (room ? undefined : fresh));
    if (res.committed) {
      if (DEV) console.log(`[online] created rooms/${code}`);
      return store(SESSION_KEY, { code, color: 'w' });
    }
  }
  throw new Error('Could not create a room — please try again.');
}

/**
 * What joining does to a room: reclaim the seat this player already holds,
 * take Black, or refuse. Returns { room, color } to write, or { refusal }.
 * A missing `room` aborts the transaction, which is what `undefined` means.
 */
export function takeSeat(room, id) {
  if (!room) return { refusal: `No such room.` };
  const players = room.players || {};
  // Reconnecting: the seat is already ours, so nothing needs writing.
  if (players.w === id) return { room, color: 'w' };
  if (players.b === id) return { room, color: 'b' };
  if (players.b) return { refusal: 'That room already has two players.' };
  return { room: { ...room, players: { ...players, b: id } }, color: 'b' };
}

/**
 * Joins `rawCode` as Black, or reclaims the seat this browser already holds
 * there. Returns { code, color }.
 */
export async function joinRoom(rawCode) {
  const code = normalizeCode(rawCode);
  if (code.length !== 6) throw new Error('Room codes are 6 letters or digits.');

  const { db, ref, onValue, runTransaction } = await sdk();
  const id = playerId();
  const room = ref(db, `rooms/${code}`);

  // runTransaction calls takeSeat once, synchronously, against whatever the
  // local cache already holds, and a refusal (undefined) ends the transaction
  // right there without ever asking the server. A browser that has never seen
  // this room has an empty cache, so the first run saw null and refused itself.
  // get() does not help: it caches the value only until its own promise
  // settles. Only a listener held open across the transaction keeps the room in
  // the cache long enough for takeSeat to see it.
  let detach = () => {};
  try {
    const first = await new Promise((resolve, reject) => {
      detach = onValue(room, resolve, reject);
    });
    if (DEV) console.log(`[online] join rooms/${code} →`, first.val());
    if (!first.exists()) throw new Error(`No room called ${code}.`);

    let seat = {};
    const res = await runTransaction(room, (current) => (seat = takeSeat(current, id)).room);
    if (!res.committed || !seat.color) throw new Error(seat.refusal || `Could not join ${code}.`);
    return store(SESSION_KEY, { code, color: seat.color });
  } finally {
    detach();
  }
}

/**
 * Subscribes to a room. `onRoom(room, error)` gets { players, moves } — moves
 * flattened to a plain array — or (null, undefined) when the room is gone and
 * (null, error) when the listener itself was refused. Returns the unsubscribe.
 */
export async function watch(code, onRoom) {
  const { db, ref, onValue } = await sdk();
  return onValue(
    ref(db, `rooms/${code}`),
    (snap) => onRoom(shape(snap.val())),
    (err) => onRoom(null, err)
  );
}

// Realtime Database hands back contiguous numeric keys as a (possibly sparse)
// array and everything else as an object, so index off the front either way.
export function shape(room) {
  if (!room) return null;
  const raw = room.moves || {};
  const moves = [];
  for (let i = 0; raw[i]; i++) moves.push(raw[i]);
  // tc/clock/conn/over are passed through untouched — absent stays absent.
  return { players: room.players || {}, moves, tc: room.tc, clock: room.clock, conn: room.conn, over: room.over };
}

/**
 * Writes the move that occupies ply `index` (0-based, White's first = 0),
 * together with the clock it leaves behind — one write, so a device can never
 * see the move without the time it was played in.
 */
export async function pushMove(code, index, { from, to, promo }, clock = null) {
  const { db, ref, update } = await sdk();
  const patch = { [`moves/${index}`]: promo ? { f: from, t: to, p: promo } : { f: from, t: to } };
  if (clock) patch.clock = clock;
  await update(ref(db, `rooms/${code}`), patch);
}

/**
 * Records an ending the move list can't show — a flag fall, a walk-out. Both
 * devices may spot the same one, so the first write is the one that counts.
 */
export async function endGame(code, winner, reason) {
  const { db, ref, runTransaction } = await sdk();
  await runTransaction(ref(db, `rooms/${code}/over`), (over) =>
    over ? undefined : { winner, reason, at: serverNow() }
  );
}

/**
 * Marks this seat present, and arms the server to stamp the moment we drop —
 * a closed tab never gets to write anything itself. Every reconnection has to
 * re-arm and re-announce: the stamp the server already spent is gone, and a
 * connection that healed on its own would otherwise still read as a walk-out.
 * Returns the unsubscribe.
 */
export async function markOnline(code, color) {
  const { db, ref, set, onValue, onDisconnect, serverTimestamp } = await sdk();
  const seat = ref(db, `rooms/${code}/conn/${color}`);
  return onValue(ref(db, '.info/connected'), async (snap) => {
    if (!snap.val()) return;
    await onDisconnect(seat).set(serverTimestamp());
    set(seat, true);
  });
}

/** Leaving on purpose: disarm the stamp, so nobody waits out a grace period. */
export async function markOffline(code, color) {
  const { db, ref, set, onDisconnect } = await sdk();
  const seat = ref(db, `rooms/${code}/conn/${color}`);
  await onDisconnect(seat).cancel();
  await set(seat, null);
}

/** Rematch: clearing the move list resets both boards through the listener. */
export async function resetGame(code) {
  const { db, ref, update } = await sdk();
  await update(ref(db, `rooms/${code}`), { moves: null, clock: null, over: null });
}
