// The half of online play that isn't Firebase: reading a room snapshot back,
// and replaying its move list into an identical position. Firebase's own
// transport is not re-tested here — only what we do with what it hands us.
//   node scripts/test-online.mjs
import factory from '../public/wasm/chess_engine.js';
import { createEngine } from '../src/js/engine.js';
import { afterMove, normalizeCode, remaining, shape, takeSeat, timeControl } from '../src/js/online.js';

let pass = 0;
const failures = [];
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) pass++;
  else failures.push(`${name}\n    expected ${b}\n    actual   ${a}`);
}
const sq = (n) => 'abcdefgh'.indexOf(n[0]) + (Number(n[1]) - 1) * 8;

// --- snapshot shape ---------------------------------------------------------
check('missing room', shape(null), null);
check('fresh room', shape({ players: { w: 'a' } }), { players: { w: 'a' }, moves: [] });
// Contiguous numeric keys come back as an array...
check('array form', shape({ moves: [{ f: 12, t: 28 }] }).moves, [{ f: 12, t: 28 }]);
// ...and as an object once a key is missing, which is also how a half-written
// room would look. Either way, only the unbroken run from 0 counts.
check('object form', shape({ moves: { 0: { f: 12, t: 28 }, 1: { f: 52, t: 36 } } }).moves.length, 2);
check('hole stops the run', shape({ moves: { 0: { f: 12, t: 28 }, 2: { f: 1, t: 18 } } }).moves.length, 1);
check('players default', shape({ moves: [] }).players, {});

// --- room codes -------------------------------------------------------------
check('lowercase input', normalizeCode(' ab3d9x '), 'AB3D9X');
check('punctuation stripped', normalizeCode('AB3-D9X'), 'AB3D9X');
check('empty input', normalizeCode(undefined), '');

// --- seating ----------------------------------------------------------------
const host = { players: { w: 'host' } };
const full = { players: { w: 'host', b: 'guest' } };

check('joiner takes black', takeSeat(host, 'guest'), { room: full, color: 'b' });
check('host does not lose its seat', takeSeat(host, 'host'), { room: host, color: 'w' });
// The whole point of the stored player id: a refresh gets the same colour back
// rather than being told the room is full.
check('white reclaims after refresh', takeSeat(full, 'host').color, 'w');
check('black reclaims after refresh', takeSeat(full, 'guest').color, 'b');
check('reclaim writes nothing new', takeSeat(full, 'guest').room, full);
check('third player refused', takeSeat(full, 'nosy').color, undefined);
check('third player told why', Boolean(takeSeat(full, 'nosy').refusal), true);
// A transaction handler returning undefined is how the SDK is told to abort.
check('refusal aborts the write', takeSeat(full, 'nosy').room, undefined);
check('missing room refused', takeSeat(null, 'guest').room, undefined);

// --- clocks -----------------------------------------------------------------
// Only the side to move is spending, and both devices work it out from the
// instant of the last move, so the same snapshot has to read the same on each.
const t0 = 1_000_000;
const clock = { w: 60_000, b: 60_000, at: t0, turn: 'w' };

check('idle clock unchanged', remaining(clock, 'b', t0 + 9_000), 60_000);
check('mover is spending', remaining(clock, 'w', t0 + 9_000), 51_000);
check('never below zero', remaining(clock, 'w', t0 + 90_000), 0);
// A device whose own clock reads behind the server's must not gain time.
check('backwards clock is free', remaining(clock, 'w', t0 - 5_000), 60_000);

const inc2 = afterMove(clock, 2, t0 + 9_000);
check('increment paid on completion', inc2.w, 53_000);
check('opponent untouched', inc2.b, 60_000);
check('turn handed over', inc2.turn, 'b');
check('opponent now spending', remaining(inc2, 'b', t0 + 12_000), 57_000);
check('mover now idle', remaining(inc2, 'w', t0 + 12_000), 53_000);

const noInc = afterMove(clock, 0, t0 + 9_000);
check('no increment adds nothing', noInc.w, 51_000);
// Sitting on the flag is a loss the instant it reads zero, whatever else is on
// the board — both devices derive it from this one number.
check('flag falls at zero', remaining(afterMove(clock, 0, t0 + 60_000), 'w', t0 + 60_000), 0);

check('preset lookup', timeControl('3+2').base, 180);
check('preset increment', timeControl('10+5').inc, 5);
check('unknown preset is untimed', timeControl('nonsense').id, 'none');
check('untimed preset has no base', timeControl('none').base, undefined);

// --- replay: the actual guarantee both devices depend on --------------------
const live = await createEngine(factory);
const wire = []; // exactly what pushMove() writes, in order

// Scholar's mate, then a promotion line, so castling/capture/promo all ride along.
const script = [
  ['e2', 'e4', ''], ['e7', 'e5', ''],
  ['f1', 'c4', ''], ['b8', 'c6', ''],
  ['g1', 'f3', ''], ['g8', 'f6', ''],
  ['e1', 'g1', ''], ['f8', 'c5', ''], // white castles
  ['f3', 'e5', ''], ['c6', 'e5', ''], // trade on e5
];
for (const [from, to, promo] of script) {
  const f = sq(from);
  const t = sq(to);
  if (!live.move(f, t, promo)) failures.push(`script move ${from}${to} was rejected`);
  wire.push(promo ? { f, t, p: promo } : { f, t });
}

const replayed = await createEngine(factory);
replayed.newGame();
for (const m of wire) {
  if (!replayed.move(m.f, m.t, m.p || '')) failures.push(`replay rejected ${JSON.stringify(m)}`);
}
check('replayed FEN matches', replayed.state().fen, live.state().fen);
check('replayed history matches', replayed.state().history, live.state().history);

// A promotion has to survive the wire, since the piece choice isn't derivable
// from the from/to pair alone.
const promo = await createEngine(factory);
promo.setFen('8/P7/8/8/8/8/8/K6k w - - 0 1');
promo.move(sq('a7'), sq('a8'), 'n');
const promoWire = { f: sq('a7'), t: sq('a8'), p: 'n' };
const promoReplay = await createEngine(factory);
promoReplay.setFen('8/P7/8/8/8/8/8/K6k w - - 0 1');
promoReplay.move(promoWire.f, promoWire.t, promoWire.p || '');
check('promotion piece survives', promoReplay.state().board, promo.state().board);
check('promotion is a knight', promoReplay.state().board[sq('a8')], 'N');

// Rematch: an emptied move list has to leave a startpos both sides agree on.
const fresh = await createEngine(factory);
check('reset board', (replayed.newGame(), replayed.state().fen), fresh.state().fen);

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.error('\n' + failures.map((f) => '  ✗ ' + f).join('\n'));
  process.exit(1);
}
