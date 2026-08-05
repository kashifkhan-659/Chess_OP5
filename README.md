# Gambit — WebAssembly Chess

A complete chess game that runs entirely in the browser. The rules and the AI
are written in C++ and compiled to WebAssembly; the interface is plain HTML,
CSS and ES modules. No backend, no framework, no build-time dependencies.

- **Full rules** — castling, en passant, promotion, check/checkmate/stalemate,
  the fifty-move rule, threefold repetition and insufficient material.
- **Three modes** — local two-player, four levels of computer opponent, or
  [online play against a friend](#online-play) over a 6-character room code.
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
.env        Firebase values for online play (git-ignored, see .env.example)
```

`src/js/firebase-config.js` is generated from `.env` by the build and is also
git-ignored — don't edit it by hand.

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

## Online play

Two people on different devices, one shared room code. The site stays static —
Firebase Realtime Database is the only server involved, and the browser talks
to it directly.

**How it works.** One player picks **Online**, chooses a time control and hits
**Create game** for a code like `K7QP2M`; the other picks **Online**, types the
code and hits **Join**. The creator is White, the joiner is Black.

A room stores the move list, plus the little that can't be derived from it:

```
/rooms/K7QP2M
  createdAt: 1754400000000
  players:   { w: "<player id>", b: "<player id>" }
  moves:     { 0: {f:12, t:28}, 1: {f:52, t:36}, 2: {f:5, t:26, p:"q"}, ... }
  tc:        { id: "5+0", base: 300, inc: 0 }      — absent on an untimed room
  clock:     { w: 291400, b: 300000, at: <ms>, turn: "b" }
  conn:      { w: true, b: 1754400090000 }         — a number is when they dropped
  over:      { winner: "w", reason: "time", at: <ms> }
```

Whose turn it is, the position, check, checkmate and every draw condition are
all recomputed by the same WASM engine on both devices, so none of it can drift
between them. Each client keeps a live listener on the room; an opponent's move
lands as a new entry and is replayed locally the moment it arrives. The board
is locked whenever it isn't your turn, and until the second player has joined.

**Clocks.** Presets run from 1+0 bullet to 30-minute classical, with **No
clock** for an untimed game. A move and the clock it leaves behind are written
together, so neither device can see one without the other, and both derive the
running time from the timestamp of that last move rather than from a countdown
of their own — a laggy connection costs the player who has it, not the one who
doesn't, and the two screens can't disagree about who ran out first. Increments
are paid on completing a move. A flag that falls is a loss on the spot,
whatever is on the board.

**Leaving.** The server is told to stamp the moment a player's connection drops
before that player ever needs it, so a closed tab or a dead network still
registers. The one left behind sees a 60-second countdown and wins if it runs
out; the clock keeps running against the absent player throughout, so
disconnecting is not a way to stall. Rejoining inside the window picks the game
straight back up. Pressing **Leave room** is deliberate, so it forfeits at once.

The room code and your colour are kept in `localStorage`, so a refresh or a
dropped connection rejoins the same room and replays the move list to catch up.
Old rooms are simply left in the database — there is no cleanup job.

### Setting it up

**1.** Create a project at [console.firebase.google.com](https://console.firebase.google.com),
then **Build → Realtime Database → Create Database**.

**2.** Under **Rules**, allow reads and writes to rooms. Anyone with a code can
play, which is the intent; the rules below at least stop the database being
used as free general-purpose storage:

```json
{
  "rules": {
    "rooms": {
      "$code": {
        ".read": "$code.length === 6",
        ".write": "$code.length === 6",
        ".validate": "newData.hasChildren(['players'])",
        "moves": {
          "$ply": { ".validate": "newData.hasChildren(['f','t'])" }
        }
      }
    }
  }
}
```

**3.** **Project settings → General → Your apps → Web app** gives you a config
object. Copy `.env.example` to `.env` and paste the values in:

```bash
cp .env.example .env
```

`.env` is git-ignored. These values are not secrets — they ship to every
browser either way — but keeping them out of the repo means the project isn't
tied to one Firebase account.

`npm run dev` and `npm run build` read `.env` (and the real environment, which
wins) and generate `src/js/firebase-config.js`. Without those variables the
config is `null` and the **Online** option simply doesn't appear; everything
else works exactly as before.

The Firebase SDK itself is loaded from Google's ESM CDN on first use, so there
is still no bundler and nothing to install.

## Deploying to Vercel

1. Push the repo to GitHub.
2. On vercel.com: **Add New Project** → import the repo → **Deploy**.

`vercel.json` already sets the build command and output directory, so nothing
else needs configuring. Every push to your default branch redeploys.

**For online play, add the same variables** under **Settings → Environment
Variables**, for Production, Preview and Development:

| Name | Value |
| --- | --- |
| `FIREBASE_API_KEY` | `apiKey` from the Firebase config |
| `FIREBASE_AUTH_DOMAIN` | `authDomain` |
| `FIREBASE_DATABASE_URL` | `databaseURL` |
| `FIREBASE_PROJECT_ID` | `projectId` |
| `FIREBASE_STORAGE_BUCKET` | `storageBucket` |
| `FIREBASE_MESSAGING_SENDER_ID` | `messagingSenderId` |
| `FIREBASE_APP_ID` | `appId` |

They are read at build time, so **redeploy after adding them** — changing an
environment variable does not update an existing deployment. The build log
prints `online play enabled` or `online play will be hidden`, which is the
quickest way to confirm they took.

Also add your Vercel domain under **Firebase → Authentication → Settings →
Authorised domains** if you later add sign-in; Realtime Database alone does not
need it.

The site is otherwise fully static — it can equally be dropped on GitHub Pages,
Netlify, Cloudflare Pages, or any web server. The only requirement is that
`.wasm` is served as `application/wasm`, which all of them do by default.

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

Undo is disabled in online games — taking a move back needs both players to
agree, and nothing here asks them. **New game** in a room restarts it for both
players.

Sound is synthesised with the Web Audio API, so there are no audio files to
load. Theme, sound, opponent and colour preferences persist in `localStorage`.

[0x88]: https://www.chessprogramming.org/0x88
[perft]: https://www.chessprogramming.org/Perft
