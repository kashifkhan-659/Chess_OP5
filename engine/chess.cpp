#include "chess.hpp"

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <sstream>

namespace chess {

// ---------------------------------------------------------------- constants

static const int KNIGHT_OFF[8] = {33, 31, 18, 14, -14, -18, -31, -33};
static const int BISHOP_OFF[4] = {17, 15, -15, -17};
static const int ROOK_OFF[4] = {16, 1, -1, -16};
// King and queen share directions; the queen just slides along them.
static const int KING_OFF[8] = {17, 16, 15, 1, -1, -15, -16, -17};

// Any move touching one of these squares kills the matching castling right.
static int CASTLE_MASK[128];

static u64 zPiece[16][128];
static u64 zSide;
static u64 zCastle[16];
static u64 zEP[8];
static bool zInit = false;

static u64 rngState = 0x9E3779B97F4A7C15ULL;
static u64 nextRandom() {
    u64 z = (rngState += 0x9E3779B97F4A7C15ULL);
    z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ULL;
    z = (z ^ (z >> 27)) * 0x94D049BB133111EBULL;
    return z ^ (z >> 31);
}

void initZobrist() {
    if (zInit) return;
    zInit = true;
    rngState = 0x9E3779B97F4A7C15ULL;
    for (int p = 0; p < 16; ++p)
        for (int s = 0; s < 128; ++s) zPiece[p][s] = nextRandom();
    // An empty square must not contribute to the hash.
    for (int s = 0; s < 128; ++s) zPiece[0][s] = 0;
    zSide = nextRandom();
    for (int i = 0; i < 16; ++i) zCastle[i] = nextRandom();
    for (int i = 0; i < 8; ++i) zEP[i] = nextRandom();

    for (int s = 0; s < 128; ++s) CASTLE_MASK[s] = 15;
    CASTLE_MASK[0x00] = 15 & ~CR_WQ;
    CASTLE_MASK[0x04] = 15 & ~(CR_WK | CR_WQ);
    CASTLE_MASK[0x07] = 15 & ~CR_WK;
    CASTLE_MASK[0x70] = 15 & ~CR_BQ;
    CASTLE_MASK[0x74] = 15 & ~(CR_BK | CR_BQ);
    CASTLE_MASK[0x77] = 15 & ~CR_BK;
}

std::string squareName(int sq) {
    std::string s;
    s += char('a' + fileOf(sq));
    s += char('1' + rankOf(sq));
    return s;
}

char pieceChar(int piece) {
    static const char* w = " PNBRQK";
    static const char* b = " pnbrqk";
    if (!piece) return ' ';
    return pieceColor(piece) == WHITE ? w[pieceType(piece)] : b[pieceType(piece)];
}

// ------------------------------------------------------------- board basics

void Position::putPiece(int sq, int piece) {
    board[sq] = piece;
    key ^= zPiece[piece][sq];
}

void Position::removePiece(int sq) {
    key ^= zPiece[board[sq]][sq];
    board[sq] = 0;
}

void Position::movePiece(int from, int to) {
    int p = board[from];
    key ^= zPiece[p][from] ^ zPiece[p][to];
    board[to] = p;
    board[from] = 0;
}

void Position::clear() {
    initZobrist();
    std::memset(board, 0, sizeof(board));
    side = WHITE;
    castling = 0;
    ep = -1;
    halfmove = 0;
    fullmove = 1;
    key = 0;
    kingSq[0] = kingSq[1] = 0;
    undoStack.clear();
    repKeys.clear();
    log.clear();
}

void Position::setStartPosition() {
    setFEN("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
}

bool Position::setFEN(const std::string& f) {
    initZobrist();
    std::istringstream ss(f);
    std::string placement, stm, rights, epStr;
    int hm = 0, fm = 1;
    if (!(ss >> placement >> stm)) return false;
    if (!(ss >> rights)) rights = "-";
    if (!(ss >> epStr)) epStr = "-";
    ss >> hm;
    ss >> fm;

    clear();

    int rank = 7, file = 0;
    for (char c : placement) {
        if (c == '/') {
            if (file != 8) return false;
            --rank;
            file = 0;
            if (rank < 0) return false;
            continue;
        }
        if (c >= '1' && c <= '8') {
            file += c - '0';
            if (file > 8) return false;
            continue;
        }
        if (file > 7 || rank < 0) return false;
        int color = (c >= 'a') ? BLACK : WHITE;
        char lc = (c >= 'a') ? c : char(c + 32);
        int type;
        switch (lc) {
            case 'p': type = PAWN; break;
            case 'n': type = KNIGHT; break;
            case 'b': type = BISHOP; break;
            case 'r': type = ROOK; break;
            case 'q': type = QUEEN; break;
            case 'k': type = KING; break;
            default: return false;
        }
        int sq = rank * 16 + file;
        putPiece(sq, makePiece(type, color));
        if (type == KING) kingSq[color] = sq;
        ++file;
    }
    if (rank != 0 || file != 8) return false;

    side = (stm == "b") ? BLACK : WHITE;
    for (char c : rights) {
        if (c == 'K') castling |= CR_WK;
        else if (c == 'Q') castling |= CR_WQ;
        else if (c == 'k') castling |= CR_BK;
        else if (c == 'q') castling |= CR_BQ;
    }
    if (epStr.size() == 2 && epStr[0] >= 'a' && epStr[0] <= 'h' && epStr[1] >= '1' && epStr[1] <= '8')
        ep = (epStr[1] - '1') * 16 + (epStr[0] - 'a');
    halfmove = hm < 0 ? 0 : hm;
    fullmove = fm < 1 ? 1 : fm;

    if (side == BLACK) key ^= zSide;
    key ^= zCastle[castling];
    if (ep >= 0) key ^= zEP[fileOf(ep)];

    repKeys.push_back(key);
    return true;
}

std::string Position::getFEN() const {
    std::string out;
    for (int r = 7; r >= 0; --r) {
        int empty = 0;
        for (int fl = 0; fl < 8; ++fl) {
            int p = board[r * 16 + fl];
            if (!p) {
                ++empty;
                continue;
            }
            if (empty) {
                out += char('0' + empty);
                empty = 0;
            }
            out += pieceChar(p);
        }
        if (empty) out += char('0' + empty);
        if (r) out += '/';
    }
    out += side == WHITE ? " w " : " b ";
    if (!castling) out += '-';
    else {
        if (castling & CR_WK) out += 'K';
        if (castling & CR_WQ) out += 'Q';
        if (castling & CR_BK) out += 'k';
        if (castling & CR_BQ) out += 'q';
    }
    out += ' ';
    out += (ep >= 0) ? squareName(ep) : "-";
    char tail[32];
    std::snprintf(tail, sizeof(tail), " %d %d", halfmove, fullmove);
    out += tail;
    return out;
}

// ----------------------------------------------------------- attack testing

bool Position::isAttacked(int sq, int by) const {
    // Pawns: step backwards from `sq` along the attacker's capture directions.
    if (by == WHITE) {
        int s = sq - 17;
        if (onBoard(s) && board[s] == makePiece(PAWN, WHITE)) return true;
        s = sq - 15;
        if (onBoard(s) && board[s] == makePiece(PAWN, WHITE)) return true;
    } else {
        int s = sq + 17;
        if (onBoard(s) && board[s] == makePiece(PAWN, BLACK)) return true;
        s = sq + 15;
        if (onBoard(s) && board[s] == makePiece(PAWN, BLACK)) return true;
    }
    for (int i = 0; i < 8; ++i) {
        int s = sq + KNIGHT_OFF[i];
        if (onBoard(s) && board[s] == makePiece(KNIGHT, by)) return true;
    }
    for (int i = 0; i < 8; ++i) {
        int s = sq + KING_OFF[i];
        if (onBoard(s) && board[s] == makePiece(KING, by)) return true;
    }
    for (int i = 0; i < 4; ++i) {
        for (int s = sq + BISHOP_OFF[i]; onBoard(s); s += BISHOP_OFF[i]) {
            int p = board[s];
            if (!p) continue;
            if (pieceColor(p) == by && (pieceType(p) == BISHOP || pieceType(p) == QUEEN)) return true;
            break;
        }
    }
    for (int i = 0; i < 4; ++i) {
        for (int s = sq + ROOK_OFF[i]; onBoard(s); s += ROOK_OFF[i]) {
            int p = board[s];
            if (!p) continue;
            if (pieceColor(p) == by && (pieceType(p) == ROOK || pieceType(p) == QUEEN)) return true;
            break;
        }
    }
    return false;
}

// --------------------------------------------------------- move generation

void Position::generate(MoveList& list, bool capturesOnly) const {
    const int us = side, them = side ^ 1;
    list.count = 0;

    for (int sq = 0; sq < 128; ++sq) {
        if (sq & 0x88) {
            sq += 7;  // jump the 8-square gap at the end of each rank
            continue;
        }
        int p = board[sq];
        if (!p || pieceColor(p) != us) continue;
        int t = pieceType(p);

        if (t == PAWN) {
            const int fwd = (us == WHITE) ? 16 : -16;
            const int startRank = (us == WHITE) ? 1 : 6;
            const int promoRank = (us == WHITE) ? 7 : 0;
            const int caps[2] = {fwd - 1, fwd + 1};
            for (int i = 0; i < 2; ++i) {
                int to = sq + caps[i];
                if (!onBoard(to)) continue;
                int victim = board[to];
                if (victim && pieceColor(victim) == them) {
                    if (rankOf(to) == promoRank)
                        for (int pr = QUEEN; pr >= KNIGHT; --pr)
                            list.add(sq, to, pr, F_CAPTURE | F_PROMO);
                    else
                        list.add(sq, to, 0, F_CAPTURE);
                } else if (!victim && ep >= 0 && to == ep) {
                    list.add(sq, to, 0, F_CAPTURE | F_EP);
                }
            }
            int one = sq + fwd;
            if (onBoard(one) && !board[one]) {
                if (rankOf(one) == promoRank) {
                    // Queen promotions are searched even in quiescence.
                    if (capturesOnly) list.add(sq, one, QUEEN, F_PROMO);
                    else
                        for (int pr = QUEEN; pr >= KNIGHT; --pr) list.add(sq, one, pr, F_PROMO);
                } else if (!capturesOnly) {
                    list.add(sq, one, 0, 0);
                    int two = sq + 2 * fwd;
                    if (rankOf(sq) == startRank && !board[two]) list.add(sq, two, 0, F_DOUBLE);
                }
            }
        } else if (t == KNIGHT || t == KING) {
            const int* off = (t == KNIGHT) ? KNIGHT_OFF : KING_OFF;
            for (int i = 0; i < 8; ++i) {
                int to = sq + off[i];
                if (!onBoard(to)) continue;
                int victim = board[to];
                if (victim) {
                    if (pieceColor(victim) == them) list.add(sq, to, 0, F_CAPTURE);
                } else if (!capturesOnly) {
                    list.add(sq, to, 0, 0);
                }
            }
        } else {
            const int* off;
            int n;
            if (t == BISHOP) { off = BISHOP_OFF; n = 4; }
            else if (t == ROOK) { off = ROOK_OFF; n = 4; }
            else { off = KING_OFF; n = 8; }
            for (int i = 0; i < n; ++i) {
                for (int to = sq + off[i]; onBoard(to); to += off[i]) {
                    int victim = board[to];
                    if (victim) {
                        if (pieceColor(victim) == them) list.add(sq, to, 0, F_CAPTURE);
                        break;
                    }
                    if (!capturesOnly) list.add(sq, to, 0, 0);
                }
            }
        }
    }

    if (capturesOnly) return;

    // Castling. The king may not start in, pass through, or land on an
    // attacked square; the landing square is re-checked by the legality
    // filter too, which is harmless.
    if (us == WHITE) {
        if ((castling & CR_WK) && !board[0x05] && !board[0x06] && !isAttacked(0x04, BLACK) &&
            !isAttacked(0x05, BLACK) && !isAttacked(0x06, BLACK))
            list.add(0x04, 0x06, 0, F_KCASTLE);
        if ((castling & CR_WQ) && !board[0x03] && !board[0x02] && !board[0x01] &&
            !isAttacked(0x04, BLACK) && !isAttacked(0x03, BLACK) && !isAttacked(0x02, BLACK))
            list.add(0x04, 0x02, 0, F_QCASTLE);
    } else {
        if ((castling & CR_BK) && !board[0x75] && !board[0x76] && !isAttacked(0x74, WHITE) &&
            !isAttacked(0x75, WHITE) && !isAttacked(0x76, WHITE))
            list.add(0x74, 0x76, 0, F_KCASTLE);
        if ((castling & CR_BQ) && !board[0x73] && !board[0x72] && !board[0x71] &&
            !isAttacked(0x74, WHITE) && !isAttacked(0x73, WHITE) && !isAttacked(0x72, WHITE))
            list.add(0x74, 0x72, 0, F_QCASTLE);
    }
}

bool Position::isLegal(const Move& m) {
    makeMove(m);
    bool ok = !isAttacked(kingSq[side ^ 1], side);
    unmakeMove();
    return ok;
}

void Position::generateLegal(MoveList& out) {
    MoveList all;
    generate(all, false);
    out.count = 0;
    for (int i = 0; i < all.count; ++i)
        if (isLegal(all.m[i])) out.push(all.m[i]);
}

// -------------------------------------------------------- make / unmake

void Position::makeMove(const Move& m) {
    Undo u;
    u.move = m;
    u.captured = board[m.to];
    u.castling = castling;
    u.ep = ep;
    u.halfmove = halfmove;
    u.key = key;

    const int us = side;
    const int piece = board[m.from];

    if (ep >= 0) key ^= zEP[fileOf(ep)];
    key ^= zCastle[castling];

    ++halfmove;

    if (m.flags & F_EP) {
        int capSq = m.to + (us == WHITE ? -16 : 16);
        u.captured = board[capSq];
        removePiece(capSq);
        halfmove = 0;
    } else if (u.captured) {
        removePiece(m.to);
        halfmove = 0;
    }
    if (pieceType(piece) == PAWN) halfmove = 0;

    movePiece(m.from, m.to);

    if (m.flags & F_PROMO) {
        removePiece(m.to);
        putPiece(m.to, makePiece(m.promo, us));
    }
    if (m.flags & F_KCASTLE) movePiece(m.to + 1, m.to - 1);  // h-rook -> f-file
    if (m.flags & F_QCASTLE) movePiece(m.to - 2, m.to + 1);  // a-rook -> d-file
    if (pieceType(piece) == KING) kingSq[us] = m.to;

    castling &= CASTLE_MASK[m.from];
    castling &= CASTLE_MASK[m.to];

    ep = -1;
    if (m.flags & F_DOUBLE) ep = m.from + (us == WHITE ? 16 : -16);

    key ^= zCastle[castling];
    if (ep >= 0) key ^= zEP[fileOf(ep)];
    key ^= zSide;

    side = us ^ 1;
    if (us == BLACK) ++fullmove;

    undoStack.push_back(u);
    repKeys.push_back(key);
}

void Position::unmakeMove() {
    const Undo u = undoStack.back();
    undoStack.pop_back();
    repKeys.pop_back();
    const Move& m = u.move;

    side ^= 1;
    const int us = side;
    if (us == BLACK) --fullmove;

    board[m.from] = board[m.to];
    board[m.to] = 0;
    if (m.flags & F_PROMO) board[m.from] = makePiece(PAWN, us);
    if (pieceType(board[m.from]) == KING) kingSq[us] = m.from;

    if (m.flags & F_EP) {
        board[m.to + (us == WHITE ? -16 : 16)] = u.captured;
    } else if (u.captured) {
        board[m.to] = u.captured;
    }
    if (m.flags & F_KCASTLE) {
        board[m.to + 1] = board[m.to - 1];
        board[m.to - 1] = 0;
    }
    if (m.flags & F_QCASTLE) {
        board[m.to - 2] = board[m.to + 1];
        board[m.to + 1] = 0;
    }

    castling = u.castling;
    ep = u.ep;
    halfmove = u.halfmove;
    key = u.key;
}

// --------------------------------------------------------------- game level

std::string Position::sanOf(const Move& m) {
    if (m.flags & F_KCASTLE) return "O-O";
    if (m.flags & F_QCASTLE) return "O-O-O";

    static const char* LETTER = " PNBRQK";
    const int t = pieceType(board[m.from]);
    std::string s;

    if (t == PAWN) {
        if (m.flags & F_CAPTURE) {
            s += char('a' + fileOf(m.from));
            s += 'x';
        }
        s += squareName(m.to);
        if (m.flags & F_PROMO) {
            s += '=';
            s += LETTER[m.promo];
        }
        return s;
    }

    s += LETTER[t];
    // Disambiguate against other same-type pieces that can legally reach `to`.
    MoveList legal;
    generateLegal(legal);
    bool ambiguous = false, sameFile = false, sameRank = false;
    for (int i = 0; i < legal.count; ++i) {
        const Move& o = legal.m[i];
        if (o.to != m.to || o.from == m.from) continue;
        if (pieceType(board[o.from]) != t) continue;
        ambiguous = true;
        if (fileOf(o.from) == fileOf(m.from)) sameFile = true;
        if (rankOf(o.from) == rankOf(m.from)) sameRank = true;
    }
    if (ambiguous) {
        if (!sameFile) s += char('a' + fileOf(m.from));
        else if (!sameRank) s += char('1' + rankOf(m.from));
        else {
            s += char('a' + fileOf(m.from));
            s += char('1' + rankOf(m.from));
        }
    }
    if (m.flags & F_CAPTURE) s += 'x';
    s += squareName(m.to);
    return s;
}

bool Position::playMove(int from, int to, int promo) {
    MoveList legal;
    generateLegal(legal);
    const Move* found = nullptr;
    for (int i = 0; i < legal.count; ++i) {
        const Move& c = legal.m[i];
        if (c.from != from || c.to != to) continue;
        if (c.flags & F_PROMO) {
            int want = promo ? promo : QUEEN;
            if (c.promo != want) continue;
        }
        found = &c;
        break;
    }
    if (!found) return false;

    LogEntry e;
    e.move = *found;
    e.mover = side;
    e.captured = (found->flags & F_EP) ? makePiece(PAWN, side ^ 1) : board[found->to];
    e.san = sanOf(*found);

    makeMove(*found);

    if (inCheck()) {
        MoveList replies;
        generateLegal(replies);
        e.san += replies.count ? "+" : "#";
    }
    log.push_back(e);
    return true;
}

bool Position::undo() {
    if (log.empty()) return false;
    unmakeMove();
    log.pop_back();
    return true;
}

int Position::repetitionCount() const {
    int n = 0;
    // Only positions since the last irreversible move can repeat.
    int span = std::min<int>((int)repKeys.size(), halfmove + 1);
    for (int i = (int)repKeys.size() - 1; i >= (int)repKeys.size() - span; --i)
        if (repKeys[i] == key) ++n;
    return n;
}

bool Position::insufficientMaterial() const {
    int minors[2] = {0, 0};
    int bishopSquareColor[2] = {-1, -1};
    int bishops = 0, knights = 0;
    for (int sq = 0; sq < 128; ++sq) {
        if (sq & 0x88) { sq += 7; continue; }
        int p = board[sq];
        if (!p) continue;
        int t = pieceType(p);
        if (t == PAWN || t == ROOK || t == QUEEN) return false;
        if (t == KING) continue;
        int c = pieceColor(p);
        ++minors[c];
        if (t == BISHOP) {
            ++bishops;
            bishopSquareColor[c] = (rankOf(sq) + fileOf(sq)) & 1;
        } else {
            ++knights;
        }
    }
    int total = minors[0] + minors[1];
    if (total <= 1) return true;  // K vs K, K+minor vs K
    // K+B vs K+B with both bishops on the same colour complex.
    if (total == 2 && bishops == 2 && knights == 0 && minors[0] == 1 && minors[1] == 1)
        return bishopSquareColor[0] == bishopSquareColor[1];
    return false;
}

GameStatus Position::status() {
    MoveList legal;
    generateLegal(legal);
    if (legal.count == 0) return inCheck() ? CHECKMATE : STALEMATE;
    if (halfmove >= 100) return DRAW_FIFTY;
    if (repetitionCount() >= 3) return DRAW_REPETITION;
    if (insufficientMaterial()) return DRAW_MATERIAL;
    return PLAYING;
}

u64 perft(Position& pos, int depth) {
    if (depth == 0) return 1;
    MoveList list;
    pos.generate(list);
    u64 nodes = 0;
    for (int i = 0; i < list.count; ++i) {
        pos.makeMove(list.m[i]);
        if (!pos.isAttacked(pos.kingSq[pos.side ^ 1], pos.side))
            nodes += (depth == 1) ? 1 : perft(pos, depth - 1);
        pos.unmakeMove();
    }
    return nodes;
}

}  // namespace chess
