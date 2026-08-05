// Gesture tests for the board, run against a DOM stub thin enough to be obvious.
// It exists for one reason: Android's long-press fires `contextmenu` in the
// middle of a move, and twice now that has been wired up to throw the move away.
//   node scripts/test-board.mjs
import { Board } from '../src/js/board.js';

// --- the smallest DOM the board will run on ---------------------------------

function el(tag = 'div') {
  const props = new Map();
  const listeners = new Map();
  const classes = new Set();
  const node = {
    tagName: tag,
    children: [],
    offsetWidth: 0,
    innerHTML: '',
    textContent: '',
    set className(v) {
      classes.clear();
      for (const c of String(v).split(/\s+/)) if (c) classes.add(c);
    },
    get className() {
      return [...classes].join(' ');
    },
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (c) => classes.has(c),
      toggle: (c, force) => (force ?? !classes.has(c)) ? classes.add(c) : classes.delete(c),
    },
    style: {
      setProperty: (k, v) => props.set(k, v),
      getPropertyValue: (k) => props.get(k) ?? '',
      removeProperty: (k) => props.delete(k),
    },
    setAttribute() {},
    appendChild: (c) => node.children.push(c),
    append: (...c) => node.children.push(...c),
    replaceChildren: (...c) => (node.children = c.flatMap((f) => f.children ?? [f])),
    remove() {},
    querySelector: (sel) => node.q?.[sel] ?? null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 800 }),
    setPointerCapture() {},
    releasePointerCapture() {},
    addEventListener: (type, fn) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    removeEventListener: (type, fn) =>
      listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn)),
    fire: (type, ev = {}) => {
      for (const fn of [...(listeners.get(type) ?? [])]) fn({ preventDefault() {}, ...ev });
    },
  };
  return node;
}

globalThis.document = { createElement: el, createDocumentFragment: () => el('#fragment') };
globalThis.requestAnimationFrame = (fn) => fn();

// --- harness ----------------------------------------------------------------

let pass = 0;
const failures = [];
function check(name, actual, expected) {
  const [a, b] = [JSON.stringify(actual), JSON.stringify(expected)];
  if (a === b) pass++;
  else failures.push(`${name}\n    expected ${b}\n    actual   ${a}`);
}

const SQ = 100; // an 800px board, eight squares across
const xy = (sq) => ({ clientX: (sq & 7) * SQ + SQ / 2, clientY: (7 - (sq >> 3)) * SQ + SQ / 2 });
const touch = (sq, extra = {}) => ({ pointerType: 'touch', pointerId: 1, ...xy(sq), ...extra });

/** A board holding a white rook on a1 and a black pawn on a7 for it to take. */
function setup() {
  const root = el();
  root.q = { '.squares': el(), '.markers': el(), '.pieces': el(), '.coords': el() };
  const moves = [];
  const board = new Board(root, {
    onMove: (from, to) => moves.push([from, to]),
    onPickup: (sq) => (sq === 0 ? [{ to: 48, capture: true }] : []),
  });
  const position = Array(64).fill('.');
  position[0] = 'R';
  position[48] = 'p';
  board.render(position.join(''), { animate: false });
  return { root, board, moves };
}

// --- selection survives a long press ----------------------------------------
{
  const { root, board, moves } = setup();
  root.fire('pointerdown', touch(0));
  root.fire('pointerup', touch(0));
  check('a tap selects the piece', board.selected, 0);

  // Android fires this ~500ms into any press, before the finger comes up.
  root.fire('contextmenu', xy(0));
  check('a long press keeps the selection', board.selected, 0);
  check('a long press keeps the legal targets', board.targets.length, 1);

  root.fire('pointerdown', touch(48));
  check('tapping the target square captures', moves, [[0, 48]]);
  check('the capture clears the selection', board.selected, -1);
}

// --- and survives one mid-drag ----------------------------------------------
{
  const { root, board, moves } = setup();
  root.fire('pointerdown', touch(0));
  root.fire('contextmenu', xy(0));
  root.fire('pointermove', touch(48));
  root.fire('pointerup', touch(48));
  check('dragging onto the target captures after a long press', moves, [[0, 48]]);
  check('the drag leaves nothing selected', board.selected, -1);
}

// --- an empty square still deselects ----------------------------------------
{
  const { root, board, moves } = setup();
  root.fire('pointerdown', touch(0));
  root.fire('pointerup', touch(0));
  root.fire('pointerdown', touch(36)); // e5: empty, and not a legal target
  check('tapping an empty square deselects', board.selected, -1);
  check('tapping an empty square plays nothing', moves, []);
}

// --- the tap does not get replayed as a mouse click -------------------------
// Android's compat mouse replay hit-tests the touch point after the fact, so it
// lands on whatever the tap put there — the promotion dialog, which reads it as
// an outside-tap and closes. Cancelling touchend is what stops the replay.
{
  const { root } = setup();
  let cancelled = false;
  root.fire('pointerdown', touch(0));
  root.fire('touchend', { preventDefault: () => (cancelled = true) });
  check('touchend is cancelled, suppressing the compat click', cancelled, true);
}

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.error(`\n${failures.join('\n\n')}\n`);
  process.exit(1);
}
