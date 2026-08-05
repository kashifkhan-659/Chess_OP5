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
  return fb;
}

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

// -------------------------------------------------------------------- rooms

function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
}

export function normalizeCode(input) {
  return String(input || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Creates a room and seats the caller as White. Returns { code, color }. */
export async function createRoom() {
  const { db, ref, runTransaction } = await sdk();
  const id = playerId();
  // A collision needs two of 32^6 codes to land together; retry rather than
  // ever hand a player a room somebody else is already sitting in.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode();
    const res = await runTransaction(ref(db, `rooms/${code}`), (room) =>
      room ? undefined : { createdAt: Date.now(), players: { w: id } }
    );
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
  return { players: room.players || {}, moves };
}

/** Writes the move that occupies ply `index` (0-based, White's first = 0). */
export async function pushMove(code, index, { from, to, promo }) {
  const { db, ref, set } = await sdk();
  await set(ref(db, `rooms/${code}/moves/${index}`), promo ? { f: from, t: to, p: promo } : { f: from, t: to });
}

/** Rematch: clearing the move list resets both boards through the listener. */
export async function resetGame(code) {
  const { db, ref, set } = await sdk();
  await set(ref(db, `rooms/${code}/moves`), null);
}
