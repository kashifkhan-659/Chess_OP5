// Compiles engine/*.cpp to public/wasm/chess_engine.{js,wasm}.
// Finds Emscripten on PATH, or falls back to a local emsdk checkout so you
// don't have to source emsdk_env before every build.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const OUT_DIR = path.join(root, 'public', 'wasm');

function subdirs(dir) {
  try {
    return readdirSync(dir)
      .map((d) => path.join(dir, d))
      .filter((d) => statSync(d).isDirectory());
  } catch {
    return [];
  }
}

// emsdk nests its bundled python/node one or two levels deep depending on
// the platform, so look for the executable rather than guessing the layout.
function findExecDir(base, names) {
  const queue = [base, ...subdirs(base)];
  for (const dir of queue) {
    for (const extra of ['', 'bin']) {
      const candidate = extra ? path.join(dir, extra) : dir;
      if (names.some((n) => existsSync(path.join(candidate, n)))) return candidate;
    }
  }
  return null;
}

function findEmsdk() {
  const candidates = [
    process.env.EMSDK,
    path.join(root, 'emsdk'),
    path.join(os.homedir(), 'emsdk'),
    isWin ? 'C:\\emsdk' : '/usr/local/emsdk',
  ].filter(Boolean);
  return candidates.find((d) => existsSync(path.join(d, 'upstream', 'emscripten', 'emcc.py')));
}

function buildEnv() {
  const onPath = spawnSync(isWin ? 'where' : 'which', ['emcc'], { shell: isWin });
  if (onPath.status === 0) return { env: process.env, source: 'PATH' };

  const emsdk = findEmsdk();
  if (!emsdk) {
    console.error(
      [
        'Emscripten not found.',
        '',
        'Install it once:',
        '  git clone https://github.com/emscripten-core/emsdk.git ~/emsdk',
        '  cd ~/emsdk && ./emsdk install latest && ./emsdk activate latest',
        '',
        'Then re-run `npm run build:wasm` (this script auto-detects ~/emsdk),',
        'or set EMSDK to your checkout.',
      ].join('\n')
    );
    process.exit(1);
  }

  const dirs = [path.join(emsdk, 'upstream', 'emscripten'), emsdk];
  const nodeDir = findExecDir(path.join(emsdk, 'node'), ['node.exe', 'node']);
  const pyDir = findExecDir(path.join(emsdk, 'python'), ['python.exe', 'python3', 'python']);
  if (nodeDir) dirs.unshift(nodeDir);
  if (pyDir) dirs.unshift(pyDir);

  const env = { ...process.env, EMSDK: emsdk, EM_CONFIG: path.join(emsdk, '.emscripten') };
  env.PATH = dirs.join(path.delimiter) + path.delimiter + (process.env.PATH || '');
  return { env, source: emsdk };
}

const EXPORTS = [
  '_ce_ping',
  '_ce_new_game',
  '_ce_set_fen',
  '_ce_state',
  '_ce_legal_moves',
  '_ce_move',
  '_ce_undo',
  '_ce_ai_move',
  '_ce_evaluate',
  '_ce_perft',
  '_malloc',
  '_free',
];

const args = [
  path.join('engine', 'chess.cpp'),
  path.join('engine', 'search.cpp'),
  path.join('engine', 'api.cpp'),
  '-O3',
  '-std=c++17',
  '-o',
  path.join('public', 'wasm', 'chess_engine.js'),
  '-sMODULARIZE=1',
  '-sEXPORT_ES6=1',
  '-sEXPORT_NAME=createChessEngine',
  '-sENVIRONMENT=web,worker,node',
  '-sALLOW_MEMORY_GROWTH=1',
  '-sINITIAL_MEMORY=33554432',
  // The search recurses deeply and each frame holds a 5 KB MoveList, so the
  // 64 KB default stack is nowhere near enough.
  '-sSTACK_SIZE=5242880',
  '-sFILESYSTEM=0',
  '-sEXPORTED_RUNTIME_METHODS=ccall,cwrap,UTF8ToString',
  `-sEXPORTED_FUNCTIONS=${EXPORTS.join(',')}`,
];

mkdirSync(OUT_DIR, { recursive: true });
const { env, source } = buildEnv();
console.log(`emcc via: ${source}`);
console.log(`emcc ${args.join(' ')}\n`);

const res = spawnSync('emcc', args, { cwd: root, env, stdio: 'inherit', shell: isWin });
if (res.status !== 0) {
  console.error(`\nBuild failed (exit ${res.status}).`);
  process.exit(res.status ?? 1);
}
console.log(`\nWrote ${path.join('public', 'wasm', 'chess_engine.js')} + chess_engine.wasm`);
