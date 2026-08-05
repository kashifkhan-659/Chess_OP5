// Runs against the real compiled WASM artifact, so it tests exactly what ships.
//   node scripts/test.mjs
import factory from '../public/wasm/chess_engine.js';
import { createEngine } from '../src/js/engine.js';

const e = await createEngine(factory);

let pass = 0;
const failures = [];
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    pass++;
  } else {
    failures.push(`${name}\n    expected ${b}\n    actual   ${a}`);
  }
}
const sq = (n) => 'abcdefgh'.indexOf(n[0]) + (Number(n[1]) - 1) * 8;
const has = (moves, from, to) => moves.some((m) => m.from === from && m.to === to);

// --- the pipeline itself ----------------------------------------------------
check('C++ -> WASM -> JS round trip', e.ping(20), 41);

// --- perft: the real proof that move generation is correct ------------------
const PERFT = [
  ['startpos', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', [20, 400, 8902, 197281]],
  ['kiwipete', 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', [48, 2039, 97862, 4085603]],
  ['endgame pins/ep', '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', [14, 191, 2812, 43238, 674624]],
  ['promotions', 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', [6, 264, 9467, 422333]],
  ['mirror', 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', [44, 1486, 62379, 2103487]],
  ['middlegame', 'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10', [46, 2079, 89890, 3894594]],
];
for (const [name, fen, counts] of PERFT) {
  for (let d = 1; d <= counts.length; d++) {
    e.setFen(fen);
    check(`perft ${name} d${d}`, e.perft(d), counts[d - 1]);
  }
}

// --- targeted rule edge cases ----------------------------------------------
e.setFen('4r2k/8/8/8/8/8/4N3/4K3 w - - 0 1');
check(
  'absolutely pinned knight has no moves',
  e.legalMoves().filter((m) => m.from === sq('e2')).length,
  0
);

e.setFen('4kr2/8/8/8/8/8/8/R3K2R w KQ - 0 1');
{
  const moves = e.legalMoves();
  check('cannot castle through an attacked square', has(moves, sq('e1'), sq('g1')), false);
  check('can still castle on the safe side', has(moves, sq('e1'), sq('c1')), true);
}

// Capturing en passant would clear two pawns off the 4th rank at once and
// expose the king to the rook on h4, so it must be rejected.
e.setFen('8/8/8/8/kp5R/8/2P5/4K3 w - - 0 1');
e.move(sq('c2'), sq('c4'));
check('en passant that exposes the king is illegal', has(e.legalMoves(), sq('b4'), sq('c3')), false);

e.setFen('8/P6k/8/8/8/8/8/K7 w - - 0 1');
check(
  'a pawn reaching the last rank offers four promotions',
  e.legalMoves()
    .filter((m) => m.from === sq('a7'))
    .map((m) => m.promo)
    .sort(),
  ['b', 'n', 'q', 'r']
);

e.setFen('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
e.move(sq('e1'), sq('g1'));
{
  const b = e.state().board;
  check('castling relocates the rook', [b[sq('g1')], b[sq('f1')], b[sq('h1')]], ['K', 'R', '.']);
}

// --- game end detection -----------------------------------------------------
e.newGame();
for (const [f, t] of [['f2', 'f3'], ['e7', 'e5'], ['g2', 'g4'], ['d8', 'h4']]) e.move(sq(f), sq(t));
{
  const s = e.state();
  check("fool's mate is checkmate", [s.status, s.winner], ['checkmate', 'b']);
}

e.setFen('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
check('stalemate is not checkmate', e.state().status, 'stalemate');

e.setFen('4k3/8/8/8/8/8/8/4KB2 w - - 0 1');
check('king and bishop cannot mate', e.state().status, 'insufficient-material');

e.newGame();
for (const [f, t] of [['g1', 'f3'], ['g8', 'f6'], ['f3', 'g1'], ['f6', 'g8'],
                      ['g1', 'f3'], ['g8', 'f6'], ['f3', 'g1'], ['f6', 'g8']]) e.move(sq(f), sq(t));
check('threefold repetition is a draw', e.state().status, 'repetition');

// --- notation ---------------------------------------------------------------
e.newGame();
for (const [f, t] of [['e2', 'e4'], ['e7', 'e5'], ['g1', 'f3'], ['b8', 'c6'], ['f1', 'b5']])
  e.move(sq(f), sq(t));
check('algebraic notation', e.state().history.map((h) => h.san), ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5']);

e.setFen('4k3/8/8/8/4K3/8/8/R6R w - - 0 1');
e.move(sq('a1'), sq('d1'));
check('notation disambiguates by file', e.state().history[0].san, 'Rad1');

e.setFen('R7/8/8/7k/8/8/8/R3K3 w - - 0 1');
e.move(sq('a1'), sq('a4'));
check('notation disambiguates by rank when files match', e.state().history[0].san, 'R1a4');

e.newGame();
for (const [f, t] of [['f2', 'f4'], ['e7', 'e6'], ['g2', 'g4'], ['d8', 'h4']]) e.move(sq(f), sq(t));
check('mate gets a # suffix', e.state().history.at(-1).san, 'Qh4#');

// --- undo -------------------------------------------------------------------
e.newGame();
const startFen = e.state().fen;
e.move(sq('e2'), sq('e4'));
e.move(sq('c7'), sq('c5'));
e.undo();
e.undo();
check('undo restores the exact position', e.state().fen, startFen);
check('undo clears the move history', e.state().history.length, 0);

// --- saved games replay exactly (localStorage restore, and the online room) -
const GAMES = {
  'captures and castling': [['e2', 'e4'], ['d7', 'd5'], ['e4', 'd5'], ['g8', 'f6'],
                            ['g1', 'f3'], ['f6', 'd5'], ['f1', 'b5'], ['c8', 'd7'],
                            ['e1', 'g1'], ['e8', 'c8']],
  'a promotion': [['e2', 'e4'], ['d7', 'd5'], ['e4', 'd5'], ['c7', 'c6'],
                  ['d5', 'c6'], ['g8', 'f6'], ['c6', 'b7'], ['c8', 'd7'],
                  ['b7', 'a8', 'r']], // under-promotes, so 'q' can't pass by default
};
for (const [name, line] of Object.entries(GAMES)) {
  e.newGame();
  for (const [f, t, p] of line) e.move(sq(f), sq(t), p);
  const saved = e.state();
  const moves = saved.history.map((h) => [h.from, h.to, h.promo]); // what gets stored
  e.newGame();
  check(`replays a saved game with ${name}`, moves.every(([f, t, p]) => e.move(f, t, p)), true);
  check(`restores the same position after ${name}`, e.state().fen, saved.fen);
  check(`keeps the notation across ${name}`, e.state().history.map((h) => h.san),
        saved.history.map((h) => h.san));
}

// --- the AI actually plays chess -------------------------------------------
e.setFen('6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1');
{
  const m = e.aiMove(4, 3000, 0);
  check('AI finds mate in one', [m.from, m.to], [sq('a1'), sq('a8')]);
}
e.setFen('rnbqkbnr/ppp1pppp/8/3p4/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 2');
{
  const m = e.aiMove(3, 2000, 0);
  check('AI returns a legal move', has(e.legalMoves(), m.from, m.to), true);
}

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.error('\n' + failures.map((f) => '  FAIL ' + f).join('\n'));
  process.exit(1);
}
