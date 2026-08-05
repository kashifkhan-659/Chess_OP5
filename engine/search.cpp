// Evaluation + alpha-beta search: transposition table, quiescence,
// killers/history ordering, late move reductions, iterative deepening.
#include "search.hpp"

#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <vector>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#else
#include <chrono>
#endif

namespace chess {

static double nowMs() {
#ifdef __EMSCRIPTEN__
    return emscripten_get_now();
#else
    using namespace std::chrono;
    return duration<double, std::milli>(steady_clock::now().time_since_epoch()).count();
#endif
}

// ------------------------------------------------------------- evaluation

static const int VAL[7] = {0, 100, 320, 330, 500, 900, 0};

// All tables read a8..h1 (top-left to bottom-right) from White's point of view.
static const int PST_PAWN[64] = {
      0,  0,  0,  0,  0,  0,  0,  0,
     50, 50, 50, 50, 50, 50, 50, 50,
     10, 10, 20, 30, 30, 20, 10, 10,
      5,  5, 10, 25, 25, 10,  5,  5,
      0,  0,  0, 20, 20,  0,  0,  0,
      5, -5,-10,  0,  0,-10, -5,  5,
      5, 10, 10,-20,-20, 10, 10,  5,
      0,  0,  0,  0,  0,  0,  0,  0};

static const int PST_KNIGHT[64] = {
    -50,-40,-30,-30,-30,-30,-40,-50,
    -40,-20,  0,  0,  0,  0,-20,-40,
    -30,  0, 10, 15, 15, 10,  0,-30,
    -30,  5, 15, 20, 20, 15,  5,-30,
    -30,  0, 15, 20, 20, 15,  0,-30,
    -30,  5, 10, 15, 15, 10,  5,-30,
    -40,-20,  0,  5,  5,  0,-20,-40,
    -50,-40,-30,-30,-30,-30,-40,-50};

static const int PST_BISHOP[64] = {
    -20,-10,-10,-10,-10,-10,-10,-20,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -10,  0,  5, 10, 10,  5,  0,-10,
    -10,  5,  5, 10, 10,  5,  5,-10,
    -10,  0, 10, 10, 10, 10,  0,-10,
    -10, 10, 10, 10, 10, 10, 10,-10,
    -10,  5,  0,  0,  0,  0,  5,-10,
    -20,-10,-10,-10,-10,-10,-10,-20};

static const int PST_ROOK[64] = {
      0,  0,  0,  0,  0,  0,  0,  0,
      5, 10, 10, 10, 10, 10, 10,  5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
      0,  0,  0,  5,  5,  0,  0,  0};

static const int PST_QUEEN[64] = {
    -20,-10,-10, -5, -5,-10,-10,-20,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -10,  0,  5,  5,  5,  5,  0,-10,
     -5,  0,  5,  5,  5,  5,  0, -5,
      0,  0,  5,  5,  5,  5,  0, -5,
    -10,  5,  5,  5,  5,  5,  0,-10,
    -10,  0,  5,  0,  0,  0,  0,-10,
    -20,-10,-10, -5, -5,-10,-10,-20};

static const int PST_KING_MG[64] = {
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -20,-30,-30,-40,-40,-30,-30,-20,
    -10,-20,-20,-20,-20,-20,-20,-10,
     20, 20,  0,  0,  0,  0, 20, 20,
     20, 30, 10,  0,  0, 10, 30, 20};

static const int PST_KING_EG[64] = {
    -50,-40,-30,-20,-20,-30,-40,-50,
    -30,-20,-10,  0,  0,-10,-20,-30,
    -30,-10, 20, 30, 30, 20,-10,-30,
    -30,-10, 30, 40, 40, 30,-10,-30,
    -30,-10, 30, 40, 40, 30,-10,-30,
    -30,-10, 20, 30, 30, 20,-10,-30,
    -30,-30,  0,  0,  0,  0,-30,-30,
    -50,-30,-30,-30,-30,-30,-30,-50};

static const int* PST[7] = {nullptr, PST_PAWN, PST_KNIGHT, PST_BISHOP, PST_ROOK, PST_QUEEN, nullptr};

static const int PASSED_BONUS[8] = {0, 5, 12, 22, 38, 62, 95, 0};

// White reads the table straight; Black reads it vertically mirrored.
static inline int pstIndex(int sq, int color) {
    return color == WHITE ? (7 - rankOf(sq)) * 8 + fileOf(sq) : rankOf(sq) * 8 + fileOf(sq);
}

int evaluate(const Position& pos) {
    int score = 0;       // always from White's point of view until the last line
    int phase = 0;       // 24 = full opening material, 0 = bare kings
    int bishops[2] = {0, 0};
    int kingSquare[2] = {-1, -1};
    unsigned pawnRanksByFile[2][8] = {};  // bit r set if a pawn sits on file f, rank r
    int pawnCountByFile[2][8] = {};

    for (int sq = 0; sq < 128; ++sq) {
        if (sq & 0x88) { sq += 7; continue; }
        int p = pos.board[sq];
        if (!p) continue;
        int t = pieceType(p), c = pieceColor(p);
        int sign = (c == WHITE) ? 1 : -1;

        if (t == KING) {
            kingSquare[c] = sq;
            continue;
        }
        score += sign * VAL[t];
        score += sign * PST[t][pstIndex(sq, c)];

        switch (t) {
            case KNIGHT: phase += 1; break;
            case BISHOP: phase += 1; ++bishops[c]; break;
            case ROOK: phase += 2; break;
            case QUEEN: phase += 4; break;
            case PAWN: {
                int f = fileOf(sq);
                pawnRanksByFile[c][f] |= 1u << rankOf(sq);
                ++pawnCountByFile[c][f];
                break;
            }
            default: break;
        }
    }

    // Pawn structure, now that every pawn has been seen.
    for (int c = 0; c < 2; ++c) {
        int sign = (c == WHITE) ? 1 : -1;
        for (int f = 0; f < 8; ++f) {
            int n = pawnCountByFile[c][f];
            if (!n) continue;
            if (n > 1) score -= sign * 12 * (n - 1);  // doubled
            bool neighbour = (f > 0 && pawnCountByFile[c][f - 1]) ||
                             (f < 7 && pawnCountByFile[c][f + 1]);
            if (!neighbour) score -= sign * 14;  // isolated

            // Passed pawns: judge by the most advanced pawn on the file.
            unsigned mask = pawnRanksByFile[c][f];
            int mostAdvanced = -1;
            for (int r = 0; r < 8; ++r) {
                if (!(mask & (1u << r))) continue;
                if (mostAdvanced < 0 || (c == WHITE ? r > mostAdvanced : r < mostAdvanced))
                    mostAdvanced = r;
            }
            if (mostAdvanced < 0) continue;
            bool blocked = false;
            for (int df = -1; df <= 1 && !blocked; ++df) {
                int nf = f + df;
                if (nf < 0 || nf > 7) continue;
                unsigned em = pawnRanksByFile[c ^ 1][nf];
                for (int r = 0; r < 8; ++r) {
                    if (!(em & (1u << r))) continue;
                    if (c == WHITE ? (r > mostAdvanced) : (r < mostAdvanced)) { blocked = true; break; }
                }
            }
            if (!blocked) {
                int adv = (c == WHITE) ? mostAdvanced : 7 - mostAdvanced;
                score += sign * PASSED_BONUS[adv];
            }
        }
        if (bishops[c] >= 2) score += sign * 30;  // bishop pair
    }

    // Rooks like open and semi-open files.
    for (int sq = 0; sq < 128; ++sq) {
        if (sq & 0x88) { sq += 7; continue; }
        int p = pos.board[sq];
        if (!p || pieceType(p) != ROOK) continue;
        int c = pieceColor(p), f = fileOf(sq);
        int sign = (c == WHITE) ? 1 : -1;
        if (!pawnCountByFile[c][f]) score += sign * (pawnCountByFile[c ^ 1][f] ? 8 : 16);
    }

    if (phase > 24) phase = 24;
    for (int c = 0; c < 2; ++c) {
        if (kingSquare[c] < 0) continue;
        int i = pstIndex(kingSquare[c], c);
        int k = (PST_KING_MG[i] * phase + PST_KING_EG[i] * (24 - phase)) / 24;
        score += (c == WHITE ? 1 : -1) * k;
    }

    return pos.side == WHITE ? score : -score;
}

// ----------------------------------------------------------------- search

static const int INF = 32000;
static const int MATE_VALUE = 31000;
static const int MATE_BOUND = MATE_VALUE - 512;
static const int MAX_PLY = 64;

enum { TT_EXACT = 0, TT_ALPHA = 1, TT_BETA = 2 };

struct TTEntry {
    u64 key = 0;
    int score = 0;
    short depth = -1;
    unsigned char flag = 0;
    Move move;
};

static const size_t TT_SIZE = 1u << 18;  // ~8 MB
static std::vector<TTEntry> TT;

void clearSearchTables() {
    TT.assign(TT_SIZE, TTEntry());
}

static u64 rndState = 0x243F6A8885A308D3ULL;
static u64 nextRnd() {
    rndState ^= rndState << 13;
    rndState ^= rndState >> 7;
    rndState ^= rndState << 17;
    return rndState;
}

struct Searcher {
    Position* pos = nullptr;
    long nodes = 0;
    double deadline = 0;
    bool stopped = false;
    Move killers[MAX_PLY][2];
    int historyTab[16][128];

    Searcher() { std::memset(historyTab, 0, sizeof(historyTab)); }

    bool timeUp() { return nowMs() >= deadline; }
    int quiesce(int alpha, int beta, int ply);
    int alphabeta(int depth, int alpha, int beta, int ply);
    void scoreMoves(MoveList& list, int ply, const Move& ttMove);
    void pickNext(MoveList& list, int from);
};

void Searcher::scoreMoves(MoveList& list, int ply, const Move& ttMove) {
    for (int i = 0; i < list.count; ++i) {
        const Move& m = list.m[i];
        if (!ttMove.isNull() && ttMove.same(m)) {
            list.score[i] = 1 << 24;
        } else if (m.flags & F_CAPTURE) {
            int victim = (m.flags & F_EP) ? PAWN : pieceType(pos->board[m.to]);
            int attacker = pieceType(pos->board[m.from]);
            list.score[i] = (1 << 23) + VAL[victim] * 16 - VAL[attacker];
        } else if (m.flags & F_PROMO) {
            list.score[i] = (1 << 22) + VAL[m.promo];
        } else if (killers[ply][0].same(m)) {
            list.score[i] = (1 << 21) + 1;
        } else if (killers[ply][1].same(m)) {
            list.score[i] = (1 << 21);
        } else {
            list.score[i] = historyTab[pos->board[m.from]][m.to];
        }
    }
}

// Selection sort one move at a time: most searches cut off after a few tries.
void Searcher::pickNext(MoveList& list, int from) {
    int best = from;
    for (int i = from + 1; i < list.count; ++i)
        if (list.score[i] > list.score[best]) best = i;
    if (best != from) {
        std::swap(list.m[from], list.m[best]);
        std::swap(list.score[from], list.score[best]);
    }
}

int Searcher::quiesce(int alpha, int beta, int ply) {
    if (stopped) return 0;
    if ((++nodes & 1023) == 0 && timeUp()) { stopped = true; return 0; }
    if (ply >= MAX_PLY - 1) return evaluate(*pos);

    int stand = evaluate(*pos);
    if (stand >= beta) return stand;
    if (stand > alpha) alpha = stand;

    MoveList list;
    pos->generate(list, true);
    scoreMoves(list, ply, Move());

    int best = stand;
    for (int i = 0; i < list.count; ++i) {
        pickNext(list, i);
        const Move m = list.m[i];

        if (!(m.flags & F_PROMO)) {  // delta pruning
            int victim = (m.flags & F_EP) ? PAWN : pieceType(pos->board[m.to]);
            if (stand + VAL[victim] + 200 < alpha) continue;
        }

        pos->makeMove(m);
        if (pos->isAttacked(pos->kingSq[pos->side ^ 1], pos->side)) {
            pos->unmakeMove();
            continue;
        }
        int sc = -quiesce(-beta, -alpha, ply + 1);
        pos->unmakeMove();
        if (stopped) return 0;

        if (sc > best) best = sc;
        if (sc > alpha) alpha = sc;
        if (alpha >= beta) break;
    }
    return best;
}

int Searcher::alphabeta(int depth, int alpha, int beta, int ply) {
    if (stopped) return 0;
    if ((++nodes & 1023) == 0 && timeUp()) { stopped = true; return 0; }

    if (ply > 0) {
        if (pos->halfmove >= 100 || pos->repetitionCount() >= 2 || pos->insufficientMaterial())
            return 0;
        // Mate distance pruning.
        alpha = std::max(alpha, -MATE_VALUE + ply);
        beta = std::min(beta, MATE_VALUE - ply - 1);
        if (alpha >= beta) return alpha;
    }
    if (ply >= MAX_PLY - 1) return evaluate(*pos);

    const bool inChk = pos->inCheck();
    if (inChk) ++depth;  // check extension
    if (depth <= 0) return quiesce(alpha, beta, ply);

    TTEntry& slot = TT[pos->key & (TT_SIZE - 1)];
    const bool ttHit = (slot.key == pos->key);
    Move ttMove;
    if (ttHit) {
        ttMove = slot.move;
        if (ply > 0 && slot.depth >= depth) {
            int sc = slot.score;
            if (sc > MATE_BOUND) sc -= ply;
            else if (sc < -MATE_BOUND) sc += ply;
            if (slot.flag == TT_EXACT) return sc;
            if (slot.flag == TT_ALPHA && sc <= alpha) return sc;
            if (slot.flag == TT_BETA && sc >= beta) return sc;
        }
    }

    MoveList list;
    pos->generate(list);
    scoreMoves(list, ply, ttMove);

    const int origAlpha = alpha;
    int bestScore = -INF;
    Move bestMove;
    int legalCount = 0;

    for (int i = 0; i < list.count; ++i) {
        pickNext(list, i);
        const Move m = list.m[i];

        pos->makeMove(m);
        if (pos->isAttacked(pos->kingSq[pos->side ^ 1], pos->side)) {
            pos->unmakeMove();
            continue;
        }
        ++legalCount;
        const bool quiet = !(m.flags & (F_CAPTURE | F_PROMO));

        int score;
        if (legalCount == 1) {
            score = -alphabeta(depth - 1, -beta, -alpha, ply + 1);
        } else {
            int reduction = 0;
            if (depth >= 3 && legalCount > 3 && quiet && !inChk)
                reduction = (legalCount > 8) ? 2 : 1;
            score = -alphabeta(depth - 1 - reduction, -alpha - 1, -alpha, ply + 1);
            if (score > alpha && reduction)
                score = -alphabeta(depth - 1, -alpha - 1, -alpha, ply + 1);
            if (score > alpha && score < beta)
                score = -alphabeta(depth - 1, -beta, -alpha, ply + 1);
        }
        pos->unmakeMove();
        if (stopped) return 0;

        if (score > bestScore) {
            bestScore = score;
            bestMove = m;
        }
        if (score > alpha) alpha = score;
        if (alpha >= beta) {
            if (quiet) {
                if (!killers[ply][0].same(m)) {
                    killers[ply][1] = killers[ply][0];
                    killers[ply][0] = m;
                }
                int& h = historyTab[pos->board[m.from]][m.to];
                h += depth * depth;
                if (h > (1 << 20)) h >>= 1;
            }
            break;
        }
    }

    if (legalCount == 0) return inChk ? (-MATE_VALUE + ply) : 0;

    if (!ttHit || depth >= slot.depth) {
        int store = bestScore;
        if (store > MATE_BOUND) store += ply;
        else if (store < -MATE_BOUND) store -= ply;
        slot.key = pos->key;
        slot.score = store;
        slot.depth = (short)depth;
        slot.flag = (bestScore <= origAlpha) ? TT_ALPHA : (bestScore >= beta ? TT_BETA : TT_EXACT);
        slot.move = bestMove;
    }
    return bestScore;
}

SearchResult search(Position& pos, const SearchLimits& limits) {
    if (TT.size() != TT_SIZE) TT.assign(TT_SIZE, TTEntry());

    SearchResult result;
    MoveList root;
    pos.generateLegal(root);
    if (root.count == 0) return result;

    result.best = root.m[0];
    result.found = true;

    Searcher s;
    s.pos = &pos;
    s.deadline = nowMs() + (limits.movetimeMs > 0 ? limits.movetimeMs : 1e9);

    std::vector<int> scores(root.count, -INF);
    const int maxDepth = std::max(1, std::min(limits.depth, MAX_PLY - 4));

    for (int depth = 1; depth <= maxDepth; ++depth) {
        // Search the previous iteration's best moves first.
        if (depth > 1) {
            std::vector<int> order(root.count);
            for (int i = 0; i < root.count; ++i) order[i] = i;
            std::stable_sort(order.begin(), order.end(),
                             [&](int a, int b) { return scores[a] > scores[b]; });
            MoveList sorted;
            std::vector<int> sortedScores(root.count);
            for (int i = 0; i < root.count; ++i) {
                sorted.push(root.m[order[i]]);
                sortedScores[i] = scores[order[i]];
            }
            root = sorted;
            scores = sortedScores;
        }

        std::vector<int> current(root.count, -INF);
        int alpha = -INF, bestScore = -INF;
        Move bestThisDepth;

        for (int i = 0; i < root.count; ++i) {
            pos.makeMove(root.m[i]);
            int sc = -s.alphabeta(depth - 1, -INF, -alpha, 1);
            pos.unmakeMove();
            if (s.stopped) break;
            current[i] = sc;
            if (sc > bestScore) {
                bestScore = sc;
                bestThisDepth = root.m[i];
            }
            if (sc > alpha) alpha = sc;
        }

        // A half-finished iteration still beats nothing on the very first pass.
        if (s.stopped && depth > 1) break;
        if (bestScore == -INF) break;

        scores = current;
        result.best = bestThisDepth;
        result.score = bestScore;
        result.depth = depth;

        if (s.stopped) break;
        if (bestScore > MATE_BOUND || bestScore < -MATE_BOUND) break;  // mate found
        if (s.timeUp()) break;
    }

    // Weaker levels play any move that is nearly as good, so games vary.
    if (limits.randomCp > 0) {
        MoveList pool;
        for (int i = 0; i < root.count; ++i)
            if (scores[i] > -INF && scores[i] >= result.score - limits.randomCp) pool.push(root.m[i]);
        if (pool.count > 0) result.best = pool.m[nextRnd() % (unsigned)pool.count];
    }

    result.nodes = s.nodes;
    return result;
}

}  // namespace chess
