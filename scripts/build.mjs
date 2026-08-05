// Static build: merge src/ and public/ into dist/. No bundler, no transpiler —
// the browser loads the ES modules as written.
import { cpSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

const wasm = path.join(root, 'public', 'wasm', 'chess_engine.wasm');
if (!existsSync(wasm)) {
  console.error('Missing public/wasm/chess_engine.wasm — run `npm run build:wasm` first.');
  process.exit(1);
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
for (const dir of ['src', 'public']) {
  cpSync(path.join(root, dir), dist, { recursive: true });
}

console.log('Built dist/ (static — deploy this folder as-is).');
