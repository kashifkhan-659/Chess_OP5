// Runs the search off the main thread so the board never freezes while the
// computer thinks. It holds its own engine instance and is handed a FEN, so
// there is no shared state to keep in sync.
import factory from '../wasm/chess_engine.js';
import { createEngine } from './engine.js';

const ready = createEngine(factory);

self.onmessage = async (ev) => {
  const { id, fen, depth, time, random } = ev.data || {};
  try {
    const engine = await ready;
    if (!engine.setFen(fen)) throw new Error(`bad FEN: ${fen}`);
    self.postMessage({ id, move: engine.aiMove(depth, time, random) });
  } catch (err) {
    self.postMessage({ id, move: null, error: String(err) });
  }
};
