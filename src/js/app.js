import factory from '../wasm/chess_engine.js';
import { Board } from './board.js';
import { createEngine } from './engine.js';
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
  mode: 'ai',
  level: 2,
  side: 'w',
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
  return prefs.mode === 'pvp' || state.turn === prefs.side;
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
  return [...byTarget.values()];
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
  if (!engine.move(from, to, promo)) {
    sound.illegal();
    sync();
    return;
  }
  sync({ hint: { from, to, promo } });
  announce();
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
  if (last.promo) sound.promote();
  else if (last.castle) sound.castle();
  else if (last.captured) sound.capture();
  else sound.move();

  if (state.status === 'checkmate') {
    const humanWon = prefs.mode === 'pvp' || state.winner === prefs.side;
    setTimeout(() => (humanWon ? sound.win() : sound.lose()), 320);
  } else if (state.status !== 'playing') {
    setTimeout(() => sound.draw(), 320);
  } else if (state.check) {
    setTimeout(() => sound.check(), 90);
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
  generation++;
  engine.newGame();
  setOrientation(prefs.side === 'b' && prefs.mode === 'ai');
  hideOverlay();
  sync({ animate: false });
  scheduleAi();
}

function undoMove() {
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
  $('#status-text').textContent = statusText(state);
  $('#status').classList.toggle('check', state.check && state.status === 'playing');
  $('#status').classList.toggle('over', state.status !== 'playing');
  $('#turn-dot').dataset.turn = state.turn;

  renderMoves(state.history);
  renderCaptures(state.history);
  renderEval();

  $('#btn-undo').disabled = !state.history.length;
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
  if (state.status === 'playing') return hideOverlay();
  const overlay = $('#overlay');
  const mate = state.status === 'checkmate';
  $('#result-icon').textContent = mate ? (state.winner === 'w' ? '♔' : '♚') : '½';
  $('#result-title').textContent = mate ? 'Checkmate' : 'Draw';
  $('#result-sub').textContent = statusText(state).replace(/^(Checkmate|Draw) — /, '');
  overlay.hidden = false;
  requestAnimationFrame(() => overlay.classList.add('show'));
}

function hideOverlay() {
  const overlay = $('#overlay');
  overlay.classList.remove('show');
  overlay.hidden = true;
}

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
  selectIn($('#mode'), 'mode', prefs.mode);
}

$('#mode').addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-mode]');
  if (!btn || btn.dataset.mode === prefs.mode) return;
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
  if (prefs.sound) sound.move();
});

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

buildLevels();
applyMode();
applyTheme();
applySound();
selectIn($('#side'), 'side', prefs.side);
setOrientation(prefs.side === 'b' && prefs.mode === 'ai');
$('#boot').remove();
sync({ animate: false });
scheduleAi();
