// Thin typed wrapper over the WASM exports. The factory is injected so the
// same wrapper works in the browser, in a worker, and under Node in tests.
export async function createEngine(factory) {
  const mod = await factory();

  const ping = mod.cwrap('ce_ping', 'number', ['number']);
  const newGame = mod.cwrap('ce_new_game', null, []);
  const setFen = mod.cwrap('ce_set_fen', 'number', ['string']);
  const state = mod.cwrap('ce_state', 'string', []);
  const legalMoves = mod.cwrap('ce_legal_moves', 'string', []);
  const move = mod.cwrap('ce_move', 'number', ['number', 'number', 'number']);
  const undo = mod.cwrap('ce_undo', 'number', []);
  const aiMove = mod.cwrap('ce_ai_move', 'string', ['number', 'number', 'number']);
  const evaluate = mod.cwrap('ce_evaluate', 'number', []);
  const perft = mod.cwrap('ce_perft', 'number', ['number']);

  const PROMO = { n: 2, b: 3, r: 4, q: 5 };

  return {
    ping,
    newGame,
    setFen: (fen) => setFen(fen) === 1,
    state: () => JSON.parse(state()),
    legalMoves: () => JSON.parse(legalMoves()),
    /** @param promo one of 'q' 'r' 'b' 'n', or falsy to auto-queen */
    move: (from, to, promo) => move(from, to, PROMO[promo] ?? 0) === 1,
    undo: () => undo() === 1,
    /** Returns {from,to,promo,score,depth,nodes} or null. */
    aiMove: (depth, movetimeMs = 2000, randomCp = 0) =>
      JSON.parse(aiMove(depth, movetimeMs, randomCp)),
    evaluate,
    perft,
  };
}

/** a1 = 0 ... h8 = 63, matching the engine's square numbering. */
export const fileOf = (sq) => sq & 7;
export const rankOf = (sq) => sq >> 3;
export const squareName = (sq) => 'abcdefgh'[fileOf(sq)] + (rankOf(sq) + 1);
