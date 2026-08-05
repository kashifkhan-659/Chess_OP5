# Gambit — WebAssembly Chess

A complete chess game that runs entirely in the browser. The rules and the AI
are written in C++ and compiled to WebAssembly; the interface is plain HTML,
CSS and ES modules. No backend, no database, no framework, no runtime
dependencies.

- **Full rules** — castling, en passant, promotion, check/checkmate/stalemate,
  the fifty-move rule, threefold repetition and insufficient material.
- **Two modes** — local two-player, or four levels of computer opponent.
- **Move input** — drag a piece, or click it and click a destination.
- **The search runs in a Web Worker**, so the board never freezes while the
  computer thinks.

## Quick start

The compiled WebAssembly is committed, so you do not need a C++ toolchain
just to play:

```bash
npm run dev          # serves src/ + public/ at http://localhost:5173
```

Edit anything under `src/` and refresh — there is no bundler or watch step.

```bash
npm run build        # writes the static site to dist/
npm run preview      # build, then serve dist/
npm test             # runs the engine test suite against the compiled wasm
```

## Project layout

```
engine/     C++ engine — board, move generation, search, WASM API
public/     static assets, including the committed wasm build output
src/        index.html, css/, js/ — the entire UI
scripts/    build, dev server and tests (plain Node, no dependencies)
dist/       build output (git-ignored)
```

`npm run build` simply merges `src/` and `public/` into `dist/`. The browser
loads the ES modules exactly as they are written.

## Rebuilding the WebAssembly

Only needed if you change anything in `engine/`.

**1. Install Emscripten** (once):

```bash
git clone https://github.com/emscripten-core/emsdk.git ~/emsdk
cd ~/emsdk
./emsdk install latest
./emsdk activate latest
```

On Windows use `emsdk.bat` instead of `./emsdk`. There is no need to run
`emsdk_env` — the build script finds `~/emsdk` (or `$EMSDK`) on its own and
sets up the environment itself.

**2. Build:**

```bash
npm run build:wasm
```

This compiles `engine/*.cpp` into `public/wasm/chess_engine.js` +
`chess_engine.wasm`. **Commit those two files** — Vercel has no Emscripten
toolchain, so the deploy build only copies files.

**3. Verify:**

```bash
npm test
```

## Deploying to Vercel

1. Push the repo to GitHub.
2. On vercel.com: **Add New Project** → import the repo → **Deploy**.

`vercel.json` already sets the build command and output directory, so nothing
needs configuring in the dashboard. Every push to your default branch
redeploys.

The site is fully static — it can equally be dropped on GitHub Pages, Netlify,
Cloudflare Pages, or any web server. The only requirement is that `.wasm` is
served as `application/wasm`, which all of them do by default.

## The engine

`engine/chess.cpp` uses a [0x88][0x88] board. Moves are generated
pseudo-legally and then filtered by making the move and testing whether the
mover's king is attacked, which gets pins, discovered checks and the awkward
en-passant cases right by construction rather than by special-casing them.

`engine/search.cpp` is alpha-beta with a transposition table, quiescence
search, MVV-LVA capture ordering, killer/history move ordering, late move
reductions and iterative deepening under a time limit. Evaluation is material
plus piece-square tables, pawn structure and rook placement, with the king
table interpolated between middlegame and endgame.

`engine/api.cpp` is the only file that knows about WebAssembly. It exposes a
handful of C functions that take integers and return JSON strings.

### Correctness

`npm test` runs against the compiled `.wasm` — the exact artifact that ships.
It checks 25 [perft][perft] node counts across six positions chosen to stress
castling rights, promotions, pins and en passant (up to 3.9M nodes), plus
targeted cases: a pinned knight, castling through an attacked square, an en
passant capture that would expose the king, four-way promotion choice, SAN
disambiguation by file and by rank, and every draw condition.

| Level | Depth | Time budget |
| --- | --- | --- |
| Casual | 2 | 0.4 s, plays any move within ~0.9 pawns of best |
| Steady | 3 | 0.9 s |
| Sharp | 4 | 1.8 s |
| Ruthless | 6 | 3.5 s |

## Controls

| | |
| --- | --- |
| Move | Drag a piece, or click it then click a square |
| Cancel a selection | `Esc`, right-click, or click the piece again |
| `F` | Flip the board |
| `U` | Undo (in computer games this steps back past its reply) |
| `N` | New game |

Sound is synthesised with the Web Audio API, so there are no audio files to
load. Theme, sound, opponent and colour preferences persist in `localStorage`.

[0x88]: https://www.chessprogramming.org/0x88
[perft]: https://www.chessprogramming.org/Perft
