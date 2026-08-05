import factory from '../wasm/chess_engine.js';
import { Board } from './board.js';
import { createEngine } from './engine.js';
import * as net from './online.js';
import { pieceSVG } from './pieces.js';
import { createSound } from './sound.js';

const $ = (sel) => document.querySelector(sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LEVELS = [
  { id: 1, label: 'Casual', depth: 2, time: 400, random: 90 },
  { id: 2, label: 'Steady', depth: 3, time: 900, random: 30 },
  { id: 3, label: 'Sharp', depth: 4, time: 1800, random: 0 },
  { id: 4, label: 'Ruthless', depth: 6, time: 3500, random: 0 },
];
const PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9 };
const PREFS_KEY = 'gambit:prefs';

const prefs = {
  theme: 'dark',
  sound: true,
  ambience: true,
  mode: 'ai',
  level: 2,
  side: 'w',
  tc: '10+0', // time control for rooms this device creates
  ...readPrefs(),
};

function readPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
  } catch {
    return {};
  }
}
function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* private mode: prefs just won't persist */
  }
}

const sound = createSound();
const engine = await createEngine(factory);

let state = null;
let legal = [];
let flipped = prefs.side === 'b';
let thinking = false;
let generation = 0; // bumped whenever the game changes under a pending search
let promoResolve = null;
let online = null; // { code, color, ready, tc, clock, conn, over } while seated in a room
let unwatch = null;
let unpresence = null;

// ---------------------------------------------------------------- AI worker

let worker = null;
let aiSeq = 0;
try {
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.addEventListener('error', () => {
    worker = null; // fall back to the main thread
  });
} catch {
  worker = null;
}

function requestAi(fen, level) {
  if (!worker) {
    // No worker available: yield a frame first so the spinner actually paints.
    return sleep(30).then(() => engine.aiMove(level.depth, level.time, level.random));
  }
  return new Promise((resolve) => {
    const id = ++aiSeq;
    const onMessage = (ev) => {
      if (ev.data?.id !== id) return;
      worker.removeEventListener('message', onMessage);
      resolve(ev.data.move);
    };
    worker.addEventListener('message', onMessage);
    worker.postMessage({ id, fen, depth: level.depth, time: level.time, random: level.random });
  });
}

// -------------------------------------------------------------------- board

const board = new Board($('#board'), { onMove: attemptMove, onPickup: pickup });

function humanToMove() {
  // Online: the board stays locked until both seats are filled — and, in a timed
  // room, until the clock exists, so no move can be played into a clock that
  // hasn't started. Then it only unlocks on your own colour's turn. The engine
  // still has the final say on legality — this only stops you touching pieces
  // that aren't yours.
  if (prefs.mode === 'online') {
    if (!online?.ready || online.over) return false;
    if (online.tc && !online.clock) return false;
    return state.turn === online.color;
  }
  return prefs.mode === 'pvp' || state.turn === prefs.side;
}

/** The colour the person at this device is playing, or null in local games. */
function myColor() {
  if (prefs.mode === 'online') return online?.color ?? null;
  if (prefs.mode === 'ai') return prefs.side;
  return null;
}
function canPlay() {
  return state?.status === 'playing' && !thinking && humanToMove();
}

function pickup(sq) {
  if (!canPlay()) return [];
  const piece = state.board[sq];
  if (piece === '.') return [];
  const isWhite = piece === piece.toUpperCase();
  if (isWhite !== (state.turn === 'w')) return [];
  // Four promotion moves share one destination square — show it once.
  const byTarget = new Map();
  for (const m of legal) {
    if (m.from !== sq || byTarget.has(m.to)) continue;
    byTarget.set(m.to, { to: m.to, capture: m.capture });
  }
  const targets = [...byTarget.values()];
  if (targets.length) sound.pickup();
  return targets;
}

async function attemptMove(from, to) {
  const options = legal.filter((m) => m.from === from && m.to === to);
  if (!options.length) return;

  let promo = '';
  if (options[0].promo) {
    promo = await askPromotion(state.turn);
    if (!promo) {
      sync(); // cancelled — slide the piece back where it came from
      return;
    }
  }
  const ply = state.history.length; // the slot this move will occupy in the room
  if (!engine.move(from, to, promo)) {
    sound.illegal();
    sync();
    return;
  }
  sync({ hint: { from, to, promo } });
  announce();
  if (online) {
    let clock = null;
    if (online.tc && online.clock) {
      clock = net.afterMove(online.clock, online.tc.inc, net.serverNow());
      online.clock = clock; // our own clock stops now, not when the echo lands
      renderClocks();
    }
    net
      .pushMove(online.code, ply, { from, to, promo }, clock)
      .catch(() => setNote('Could not send that move — check your connection.'));
  }
  scheduleAi();
}

// --------------------------------------------------------------- game flow

function sync({ hint = null, animate = true } = {}) {
  state = engine.state();
  legal = engine.legalMoves();
  board.render(state.board, { hint, animate });
  board.setLastMove(state.lastMove);
  board.setCheck(state.checkSquare);
  board.setInteractive(canPlay());
  renderPanel();
}

/** Plays the sound for the move that was just made and any game-ending one. */
function announce() {
  const last = state.history.at(-1);
  if (!last) return;

  // When a bigger sound is queued behind it, the strike is ducked and the two
  // are spaced apart, so they read as one gesture instead of colliding.
  const over = state.status !== 'playing';
  const checking = !over && state.check;
  const soft = over || checking;

  if (last.promo) sound.promote({ soft });
  else if (last.castle) sound.castle({ soft });
  else if (last.captured) sound.capture({ soft });
  else sound.move({ soft });

  if (state.status === 'checkmate') {
    const mine = myColor();
    const humanWon = !mine || state.winner === mine; // local play: someone here won
    setTimeout(() => (humanWon ? sound.win() : sound.lose()), 300);
  } else if (over) {
    setTimeout(() => sound.draw(), 300);
  } else if (checking) {
    setTimeout(() => sound.check(), 130);
  }
}

function scheduleAi() {
  if (prefs.mode !== 'ai' || state.status !== 'playing' || state.turn === prefs.side) return;
  runAi();
}

async function runAi() {
  const myGen = generation;
  const level = LEVELS.find((l) => l.id === prefs.level) || LEVELS[1];
  thinking = true;
  board.setInteractive(false);
  setThinking(true);

  // The floor keeps instant replies from feeling like a glitch.
  const [move] = await Promise.all([requestAi(state.fen, level), sleep(340)]);

  thinking = false;
  setThinking(false);
  if (myGen !== generation) return; // the game moved on while we searched
  if (!move) {
    sync();
    return;
  }
  engine.move(move.from, move.to, move.promo);
  sync({ hint: { from: move.from, to: move.to, promo: move.promo } });
  announce();
}

function newGame() {
  // In a room the reset has to happen for both players, so it goes through the
  // database and comes back to each board as an empty move list.
  if (online) {
    net.resetGame(online.code).catch(() => setNote('Could not start a new game.'));
    return;
  }
  generation++;
  engine.newGame();
  setOrientation(prefs.side === 'b' && prefs.mode === 'ai');
  hideOverlay();
  sync({ animate: false });
  scheduleAi();
}

function undoMove() {
  if (prefs.mode === 'online') return; // taking a move back needs both players to agree
  if (!state.history.length) return;
  generation++;
  thinking = false;
  setThinking(false);
  engine.undo();
  // In computer games step back past its reply so it is your turn again.
  if (prefs.mode === 'ai' && engine.state().turn !== prefs.side) engine.undo();
  hideOverlay();
  sync();
}

// ------------------------------------------------------------------- panels

function renderPanel() {
  const room = roomOverText(); // a flag fall or a walk-out outranks the position
  $('#status-text').textContent = room || statusText(state);
  $('#status').classList.toggle('check', !room && state.check && state.status === 'playing');
  $('#status').classList.toggle('over', Boolean(room) || state.status !== 'playing');
  $('#turn-dot').dataset.turn = state.turn;

  renderMoves(state.history);
  renderCaptures(state.history);
  renderEval();

  $('#btn-undo').disabled = !state.history.length || prefs.mode === 'online';
  showOverlayIfOver();
}

function statusText(s) {
  switch (s.status) {
    case 'checkmate':
      return `Checkmate — ${s.winner === 'w' ? 'White' : 'Black'} wins`;
    case 'stalemate':
      return 'Draw — stalemate';
    case 'fifty-move':
      return 'Draw — fifty-move rule';
    case 'repetition':
      return 'Draw — threefold repetition';
    case 'insufficient-material':
      return 'Draw — insufficient material';
    default: {
      const who = s.turn === 'w' ? 'White' : 'Black';
      return s.check ? `${who} to move — check` : `${who} to move`;
    }
  }
}

function renderMoves(history) {
  const list = $('#movelist');
  const frag = document.createDocumentFragment();
  for (let i = 0; i < history.length; i += 2) {
    const li = document.createElement('li');
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = `${i / 2 + 1}.`;
    li.appendChild(num);
    for (const ply of [i, i + 1]) {
      const span = document.createElement('span');
      span.className = 'san';
      span.textContent = history[ply]?.san ?? '';
      if (ply === history.length - 1) span.classList.add('current');
      li.appendChild(span);
    }
    frag.appendChild(li);
  }
  list.replaceChildren(frag);
  list.scrollTop = list.scrollHeight;
}

/** Static evaluation in pawns, always from White's point of view. */
function renderEval() {
  if (state.status !== 'playing') {
    $('#eval').textContent = '';
    return;
  }
  const cp = (state.turn === 'w' ? 1 : -1) * engine.evaluate();
  const pawns = (cp / 100).toFixed(1);
  $('#eval').textContent = `${cp > 0 ? '+' : ''}${pawns}`;
}

function renderCaptures(history) {
  const taken = { w: [], b: [] }; // pieces captured *by* each colour
  for (const h of history) if (h.captured) taken[h.mover].push(h.captured);

  const score = (arr) => arr.reduce((n, ch) => n + PIECE_VALUE[ch.toLowerCase()], 0);
  const diff = score(taken.w) - score(taken.b);

  for (const side of ['w', 'b']) {
    const tray = $(side === 'w' ? '#tray-white' : '#tray-black');
    const sorted = [...taken[side]].sort(
      (a, b) => PIECE_VALUE[a.toLowerCase()] - PIECE_VALUE[b.toLowerCase()]
    );
    tray.innerHTML = sorted
      .map((ch) => `<span class="taken ${ch === ch.toUpperCase() ? 'w' : 'b'}">${pieceSVG(ch)}</span>`)
      .join('');
    const lead = side === 'w' ? diff : -diff;
    $(side === 'w' ? '#mat-white' : '#mat-black').textContent = lead > 0 ? `+${lead}` : '';
  }
}

function setThinking(on) {
  // #strip-top always belongs to Black, #strip-bottom to White; CSS `order`
  // swaps them when the board is flipped.
  const aiStrip = prefs.side === 'w' ? '#strip-top' : '#strip-bottom';
  for (const id of ['#strip-top', '#strip-bottom']) {
    $(id).querySelector('.thinking-tag').hidden = !(on && prefs.mode === 'ai' && id === aiStrip);
  }
  document.body.classList.toggle('thinking', on);
}

function setOrientation(next) {
  flipped = next;
  board.setOrientation(flipped);
  $('.board-area').classList.toggle('flipped', flipped);
}

function showOverlayIfOver() {
  const room = online?.over;
  if (state.status === 'playing' && !room) return hideOverlay();
  const overlay = $('#overlay');
  const mate = state.status === 'checkmate';
  const drawn = !room && !mate;
  $('#result-icon').textContent = drawn ? '½' : (room ? room.winner : state.winner) === 'w' ? '♔' : '♚';
  $('#result-title').textContent = room
    ? { time: 'Flag fell', disconnect: 'Opponent left', resign: 'Resigned' }[room.reason] || 'Game over'
    : mate
      ? 'Checkmate'
      : 'Draw';
  $('#result-sub').textContent = roomOverText() || statusText(state).replace(/^(Checkmate|Draw) — /, '');
  overlay.hidden = false;
  requestAnimationFrame(() => overlay.classList.add('show'));
}

function hideOverlay() {
  const overlay = $('#overlay');
  overlay.classList.remove('show');
  overlay.hidden = true;
}

// -------------------------------------------------- clocks and presence

const DISCONNECT_GRACE = 60_000;
const OVER_REASON = { time: 'on time', disconnect: 'by disconnection', resign: 'by resignation' };

let ticker = null;
let claimed = false; // one ending claimed per game, not one per tick

/** True while the room holds a game either player could still move in. */
function gameLive() {
  return Boolean(online?.ready) && !online.over && state.status === 'playing';
}

/** How an online game ended, when the move list alone doesn't say. */
function roomOverText() {
  const o = online?.over;
  if (!o) return null;
  return `${o.winner === 'w' ? 'White' : 'Black'} wins ${OVER_REASON[o.reason] || ''}`.trim();
}

function tick() {
  if (!online) return stopTicking();
  renderClocks();
  renderPresence();
}
function startTicking() {
  ticker ??= setInterval(tick, 200);
}
function stopTicking() {
  clearInterval(ticker);
  ticker = null;
}

function fmtClock(ms) {
  const s = Math.max(0, ms) / 1000;
  if (s < 10) return s.toFixed(1); // down here the tenths are the whole story
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

/** Warn at a tenth of the starting time, never below 10s or above a minute. */
const lowAt = (tc) => Math.min(60_000, Math.max(10_000, tc.base * 100));

/**
 * Both clocks are derived from the instant of the last move rather than from a
 * countdown this device has been running on its own, so neither player can end
 * up looking at a different time than the other.
 */
function renderClocks() {
  const live = Boolean(online?.tc && online.clock);
  // A finished game freezes its clocks — at the moment it was called if the
  // room says so, otherwise at the move that ended it.
  const now = gameLive()
    ? net.serverNow()
    : (online?.over?.at ?? online?.clock?.at ?? net.serverNow());
  for (const color of ['w', 'b']) {
    const el = $(color === 'w' ? '#clock-white' : '#clock-black');
    el.hidden = !live;
    if (!live) continue;
    const ms = net.remaining(online.clock, color, now);
    el.textContent = fmtClock(ms);
    el.classList.toggle('active', online.clock.turn === color && gameLive());
    el.classList.toggle('low', ms < lowAt(online.tc));
  }
  if (!live || !gameLive() || claimed) return;
  if (net.remaining(online.clock, online.clock.turn, now) > 0) return;
  claim(online.clock.turn === 'w' ? 'b' : 'w', 'time');
}

/**
 * The server stamps the moment a player's connection drops, so the countdown
 * is the same one on both devices and survives a refresh of this one.
 */
function renderPresence() {
  const el = $('#online-conn');
  const opp = online.color === 'w' ? 'b' : 'w';
  const droppedAt = online.conn?.[opp];
  // Only a timestamp means "the server watched them go". true, or nothing at
  // all from a player who never arrived, is not a disconnect.
  if (typeof droppedAt !== 'number' || !gameLive()) {
    el.hidden = true;
    return;
  }
  const left = Math.ceil((DISCONNECT_GRACE - (net.serverNow() - droppedAt)) / 1000);
  el.textContent = left > 0 ? `Opponent disconnected — ${left}s to reconnect…` : 'Opponent disconnected.';
  el.hidden = false;
  if (left <= 0 && !claimed) claim(online.color, 'disconnect');
}

/** Reports an ending to the room. Retried on the next tick if the write fails. */
function claim(winner, reason) {
  claimed = true;
  net.endGame(online.code, winner, reason).catch(() => {
    claimed = false;
  });
}

// ---------------------------------------------------------- online rooms

/**
 * The room holds nothing but the move list, so catching up is simply replaying
 * whatever this device hasn't seen yet. That covers a live opponent move, a
 * rematch (the list is emptied), and a refresh mid-game (replay the lot).
 */
function applyRoom(room, error) {
  if (!online) return;
  if (!room) {
    setNote(error ? 'Lost the connection to that room.' : 'That room is no longer available.');
    leaveRoom();
    return;
  }
  online.ready = Boolean(room.players.w && room.players.b);
  online.tc = room.tc || null;
  online.clock = room.clock || null;
  online.conn = room.conn || {};

  const wasOver = Boolean(online.over);
  online.over = room.over || null;
  if (wasOver && !online.over) claimed = false; // rematch: the ending is claimable again
  if (!wasOver && online.over) {
    const won = online.over.winner === online.color;
    setTimeout(() => (won ? sound.win() : sound.lose()), 300);
  }
  // Whoever gets there first starts the clock; the transaction settles the tie.
  if (online.tc && online.ready && !online.clock && !online.over) {
    net.startClock(online.code, online.tc).catch(() => {});
  }

  let local = state.history.length;
  if (room.moves.length < local) {
    generation++;
    engine.newGame();
    hideOverlay();
    local = 0;
  }

  let applied = 0;
  for (let i = local; i < room.moves.length; i++) {
    const m = room.moves[i];
    // A rejected move means the two engines have diverged; stop rather than
    // silently play on from a board the opponent isn't looking at.
    if (!engine.move(m.f, m.t, m.p || '')) {
      setNote('Lost sync with the other player — leave and rejoin the room.');
      break;
    }
    applied++;
  }

  const last = room.moves.at(-1);
  const single = applied === 1; // a catch-up replay shouldn't animate move by move
  sync({ hint: single ? { from: last.f, to: last.t, promo: last.p } : null, animate: single });
  if (single) announce();
  renderOnline();
}

async function enterRoom({ code, color }) {
  online = { code, color, ready: false, tc: null, clock: null, conn: {}, over: null };
  claimed = false;
  generation++;
  engine.newGame();
  hideOverlay();
  setOrientation(color === 'b');
  sync({ animate: false });
  renderOnline();
  unwatch?.();
  try {
    unwatch = await net.watch(code, applyRoom); // fires straight away with the room as it stands
  } catch (err) {
    leaveRoom(); // a room with no listener would just look frozen
    throw err;
  }
  unpresence = await net.markOnline(code, color).catch(() => null);
  startTicking();
  setNote(''); // we're in — clear whatever got us here
}

/**
 * `resign` is for the ways a player leaves on purpose — the button, switching
 * mode — which forfeit on the spot. A room that vanished under us doesn't.
 */
function leaveRoom({ resign = false } = {}) {
  if (online) {
    const { code, color } = online;
    if (resign && gameLive()) net.endGame(code, color === 'w' ? 'b' : 'w', 'resign').catch(() => {});
    unpresence?.(); // stop announcing the seat before giving it up
    net.markOffline(code, color).catch(() => {});
  }
  unpresence = null;
  stopTicking();
  unwatch?.();
  unwatch = null;
  online = null;
  net.clearSession();
  generation++;
  engine.newGame();
  hideOverlay();
  setOrientation(false);
  sync({ animate: false });
  renderOnline();
}

function setNote(text, bad = true) {
  const el = $('#online-note');
  el.textContent = text;
  el.hidden = !text;
  el.classList.toggle('error', bad && Boolean(text));
}

function renderOnline() {
  $('#online-lobby').hidden = Boolean(online);
  $('#online-room').hidden = !online;
  if (online) {
    const colour = online.color === 'w' ? 'White' : 'Black';
    const clock = online.tc ? net.timeControl(online.tc.id).label : 'No clock';
    $('#room-code-text').textContent = online.code;
    $('#online-you').textContent = online.ready
      ? `You are ${colour} · ${clock}`
      : `You are ${colour} · ${clock} — waiting for an opponent…`;
    $('#online-room').classList.toggle('waiting', !online.ready);
  }
  renderClocks(); // hides them again on the way out of a room
  // The strips are fixed to a colour, so naming yourself on one is enough.
  const mine = prefs.mode === 'online' ? online?.color : null;
  $('#strip-bottom .pname').textContent = mine === 'w' ? 'White — you' : 'White';
  $('#strip-top .pname').textContent = mine === 'b' ? 'Black — you' : 'Black';
}

/** Runs a room action with the button parked, surfacing any failure as a note. */
async function roomAction(btn, fn) {
  btn.disabled = true;
  setNote('');
  try {
    await enterRoom(await fn());
  } catch (err) {
    setNote(err?.message || 'Something went wrong. Please try again.');
  } finally {
    btn.disabled = false;
  }
}

function buildTimeControls() {
  const select = $('#tc');
  const groups = new Map();
  for (const tc of net.TIME_CONTROLS) {
    if (!groups.has(tc.group)) {
      const group = document.createElement('optgroup');
      group.label = tc.group;
      groups.set(tc.group, group);
      select.appendChild(group);
    }
    groups.get(tc.group).appendChild(new Option(tc.label, tc.id, false, tc.id === prefs.tc));
  }
}
$('#tc').addEventListener('change', (ev) => {
  prefs.tc = ev.target.value;
  savePrefs();
});

$('#btn-create').addEventListener('click', (ev) =>
  roomAction(ev.currentTarget, () => net.createRoom(prefs.tc))
);
$('#btn-join').addEventListener('click', (ev) =>
  roomAction(ev.currentTarget, () => net.joinRoom($('#join-code').value))
);
$('#join-code').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') $('#btn-join').click();
});
// Walking out mid-game is a decision, not an accident: no grace period.
$('#btn-leave').addEventListener('click', () => {
  setNote('');
  leaveRoom({ resign: true });
});

$('#room-code').addEventListener('click', async () => {
  const hint = $('#room-code-hint');
  try {
    await navigator.clipboard.writeText(online.code);
    hint.textContent = 'copied';
  } catch {
    hint.textContent = 'copy it manually';
  }
  setTimeout(() => (hint.textContent = 'copy'), 1600);
});

// -------------------------------------------------------- promotion dialog

function askPromotion(color) {
  const dialog = $('#promo');
  const choices = $('#promo-choices');
  choices.innerHTML = ['q', 'r', 'b', 'n']
    .map((p) => {
      const ch = color === 'w' ? p.toUpperCase() : p;
      return `<button type="button" class="promo-btn ${color}" data-promo="${p}">${pieceSVG(ch)}</button>`;
    })
    .join('');
  dialog.hidden = false;
  requestAnimationFrame(() => dialog.classList.add('show'));
  return new Promise((resolve) => {
    promoResolve = (value) => {
      dialog.classList.remove('show');
      dialog.hidden = true;
      promoResolve = null;
      resolve(value);
    };
  });
}

$('#promo').addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-promo]');
  if (btn) promoResolve?.(btn.dataset.promo);
  else if (ev.target === $('#promo')) promoResolve?.('');
});

// ------------------------------------------------------------------ controls

function buildLevels() {
  $('#level').innerHTML = LEVELS.map(
    (l) => `<button type="button" data-level="${l.id}" class="${l.id === prefs.level ? 'on' : ''}">${l.label}</button>`
  ).join('');
}

function selectIn(container, attr, value) {
  for (const btn of container.querySelectorAll('button')) {
    btn.classList.toggle('on', btn.dataset[attr] === String(value));
  }
}

function applyMode() {
  const ai = prefs.mode === 'ai';
  $('#field-level').hidden = !ai;
  $('#field-side').hidden = !ai;
  $('#field-online').hidden = prefs.mode !== 'online';
  selectIn($('#mode'), 'mode', prefs.mode);
  renderOnline();
}

$('#mode').addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-mode]');
  if (!btn || btn.dataset.mode === prefs.mode) return;
  if (online) leaveRoom({ resign: true }); // switching away gives up the seat
  setNote('');
  prefs.mode = btn.dataset.mode;
  savePrefs();
  applyMode();
  newGame();
});

$('#level').addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-level]');
  if (!btn) return;
  prefs.level = Number(btn.dataset.level);
  savePrefs();
  selectIn($('#level'), 'level', prefs.level);
});

$('#side').addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-side]');
  if (!btn || btn.dataset.side === prefs.side) return;
  prefs.side = btn.dataset.side;
  savePrefs();
  selectIn($('#side'), 'side', prefs.side);
  newGame();
});

$('#btn-new').addEventListener('click', newGame);
$('#btn-rematch').addEventListener('click', newGame);
$('#btn-undo').addEventListener('click', undoMove);
$('#btn-flip').addEventListener('click', () => setOrientation(!flipped));

function applyTheme() {
  document.documentElement.dataset.theme = prefs.theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', prefs.theme === 'dark' ? '#0c0e13' : '#d8d5cd');
}
$('#btn-theme').addEventListener('click', () => {
  prefs.theme = prefs.theme === 'dark' ? 'light' : 'dark';
  savePrefs();
  applyTheme();
});

function applySound() {
  sound.setEnabled(prefs.sound);
  const btn = $('#btn-sound');
  btn.setAttribute('aria-pressed', String(prefs.sound));
  btn.classList.toggle('off', !prefs.sound);
}
$('#btn-sound').addEventListener('click', () => {
  prefs.sound = !prefs.sound;
  savePrefs();
  applySound();
  if (prefs.sound) sound.ui(); // the click itself was swallowed while muted
});

function applyAmbience() {
  sound.setAmbience(prefs.ambience);
  const btn = $('#btn-amb');
  btn.setAttribute('aria-pressed', String(prefs.ambience));
  btn.classList.toggle('off', !prefs.ambience);
}
$('#btn-amb').addEventListener('click', () => {
  prefs.ambience = !prefs.ambience;
  savePrefs();
  applyAmbience();
});

// Every control gets its click from here, so no button can be silently mute and
// new ones are covered for free.
document.addEventListener(
  'pointerdown',
  (ev) => {
    const btn = ev.target.closest('.btn, .icon-btn, .segmented button, .promo-btn');
    if (btn && !btn.disabled) sound.ui();
  },
  true
);

// Browsers block audio until the page has been interacted with, so the context
// and the ambient bed both wait for the first gesture rather than page load.
for (const type of ['pointerdown', 'keydown']) {
  addEventListener(type, () => sound.unlock(), { once: true, capture: true });
}

document.addEventListener('keydown', (ev) => {
  if (ev.target.closest('input, textarea')) return;
  if (ev.key === 'Escape') {
    board.clearSelection();
    promoResolve?.('');
  }
  if (ev.key.toLowerCase() === 'f') $('#btn-flip').click();
  if (ev.key.toLowerCase() === 'n') $('#btn-new').click();
  if (ev.key.toLowerCase() === 'u') $('#btn-undo').click();
});

// ----------------------------------------------------------------- start up

// A deployment without Firebase env vars simply doesn't offer online play.
if (!net.onlineAvailable) {
  $('#mode [data-mode="online"]').hidden = true;
  if (prefs.mode === 'online') prefs.mode = 'ai';
}

buildLevels();
buildTimeControls();
applyMode();
applyTheme();
applySound();
applyAmbience();
selectIn($('#side'), 'side', prefs.side);
setOrientation(prefs.side === 'b' && prefs.mode === 'ai');
$('#boot').remove();
sync({ animate: false });
scheduleAi();

// A refresh reclaims the seat this browser already holds — joinRoom recognises
// the stored player id and hands back the same colour rather than a new one.
const seat = prefs.mode === 'online' && net.onlineAvailable ? net.loadSession() : null;
if (seat?.code) {
  setNote(`Reconnecting to room ${seat.code}…`, false);
  net.joinRoom(seat.code).then(enterRoom).catch((err) => {
    net.clearSession();
    setNote(err?.message || 'Could not rejoin your last room.');
  });
}
