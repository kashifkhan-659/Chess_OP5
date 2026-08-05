// 0x88 chess board: representation, move generation, make/unmake, SAN, FEN.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace chess {

using u64 = std::uint64_t;

enum Color { WHITE = 0, BLACK = 1 };
enum PieceType { NO_TYPE = 0, PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6 };

// A piece is `type | (color << 3)`, so 0 means "empty square".
enum { CR_WK = 1, CR_WQ = 2, CR_BK = 4, CR_BQ = 8 };
enum { F_CAPTURE = 1, F_EP = 2, F_DOUBLE = 4, F_KCASTLE = 8, F_QCASTLE = 16, F_PROMO = 32 };

inline int pieceType(int p) { return p & 7; }
inline int pieceColor(int p) { return (p >> 3) & 1; }
inline int makePiece(int t, int c) { return t | (c << 3); }

// 0x88: square = rank * 16 + file, so a square is off-board iff any of the
// "gap" bits are set. Offsets never reach far enough below 0 to alias back on.
inline bool onBoard(int s) { return (s & 0x88) == 0; }
inline int rankOf(int s) { return s >> 4; }
inline int fileOf(int s) { return s & 7; }
inline int to64(int s) { return (s >> 4) * 8 + (s & 7); }
inline int from64(int s) { return (s >> 3) * 16 + (s & 7); }

struct Move {
    int from = 0, to = 0, promo = 0, flags = 0;
    bool isNull() const { return from == 0 && to == 0; }
    bool same(const Move& o) const { return from == o.from && to == o.to && promo == o.promo; }
};

struct MoveList {
    Move m[256];
    int score[256];
    int count = 0;
    void add(int from, int to, int promo, int flags) {
        Move& mv = m[count];
        mv.from = from;
        mv.to = to;
        mv.promo = promo;
        mv.flags = flags;
        score[count] = 0;
        ++count;
    }
    void push(const Move& mv) {
        m[count] = mv;
        score[count] = 0;
        ++count;
    }
};

struct Undo {
    Move move;
    int captured;
    int castling;
    int ep;
    int halfmove;
    u64 key;
};

// One played move, kept only for the game record (SAN, captured-piece tray).
struct LogEntry {
    Move move;
    std::string san;
    int captured;  // piece code, 0 if none
    int mover;     // color that played it
};

enum GameStatus { PLAYING, CHECKMATE, STALEMATE, DRAW_FIFTY, DRAW_REPETITION, DRAW_MATERIAL };

class Position {
public:
    int board[128];
    int side = WHITE;
    int castling = 0;
    int ep = -1;  // 0x88 square behind a double push, or -1
    int halfmove = 0;
    int fullmove = 1;
    u64 key = 0;
    int kingSq[2] = {0, 0};

    std::vector<Undo> undoStack;
    std::vector<u64> repKeys;  // key of every position reached, including the first
    std::vector<LogEntry> log;

    Position() { setStartPosition(); }

    void clear();
    void setStartPosition();
    bool setFEN(const std::string& f);
    std::string getFEN() const;

    void generate(MoveList& list, bool capturesOnly = false) const;
    void generateLegal(MoveList& list);
    bool isAttacked(int sq, int by) const;
    bool inCheck() const { return isAttacked(kingSq[side], side ^ 1); }

    void makeMove(const Move& m);
    void unmakeMove();
    bool isLegal(const Move& m);

    // Game level: validates, records SAN, keeps the move log in sync.
    bool playMove(int from0x88, int to0x88, int promo);
    bool undo();

    GameStatus status();
    int repetitionCount() const;
    bool insufficientMaterial() const;
    std::string sanOf(const Move& m);  // call before the move is made

private:
    void putPiece(int sq, int piece);
    void removePiece(int sq);
    void movePiece(int from, int to);
};

void initZobrist();
u64 perft(Position& pos, int depth);
std::string squareName(int sq0x88);
char pieceChar(int piece);

}  // namespace chess
