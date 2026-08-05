// The WebAssembly boundary. Everything crossing into JS is a C function that
// takes/returns primitives or a JSON string owned by this module.
#include <cstdio>
#include <string>

#include "chess.hpp"
#include "search.hpp"

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif

using namespace chess;

static Position g_pos;
static std::string g_buf;  // returned string stays alive until the next call

static const char* returnBuf(const std::string& s) {
    g_buf = s;
    return g_buf.c_str();
}

static const char* statusName(GameStatus st) {
    switch (st) {
        case CHECKMATE: return "checkmate";
        case STALEMATE: return "stalemate";
        case DRAW_FIFTY: return "fifty-move";
        case DRAW_REPETITION: return "repetition";
        case DRAW_MATERIAL: return "insufficient-material";
        default: return "playing";
    }
}

static std::string num(long long v) {
    char b[32];
    std::snprintf(b, sizeof(b), "%lld", v);
    return b;
}

static std::string promoLetter(int promo) {
    switch (promo) {
        case QUEEN: return "q";
        case ROOK: return "r";
        case BISHOP: return "b";
        case KNIGHT: return "n";
        default: return "";
    }
}

static std::string buildState() {
    GameStatus st = g_pos.status();
    const bool check = g_pos.inCheck();

    std::string board(64, '.');
    for (int sq = 0; sq < 128; ++sq) {
        if (sq & 0x88) { sq += 7; continue; }
        if (g_pos.board[sq]) board[to64(sq)] = pieceChar(g_pos.board[sq]);
    }

    std::string s = "{";
    s += "\"board\":\"" + board + "\"";
    s += ",\"turn\":\"" + std::string(g_pos.side == WHITE ? "w" : "b") + "\"";

    std::string rights;
    if (g_pos.castling & CR_WK) rights += 'K';
    if (g_pos.castling & CR_WQ) rights += 'Q';
    if (g_pos.castling & CR_BK) rights += 'k';
    if (g_pos.castling & CR_BQ) rights += 'q';
    s += ",\"castling\":\"" + rights + "\"";
    s += ",\"ep\":" + num(g_pos.ep >= 0 ? to64(g_pos.ep) : -1);
    s += ",\"halfmove\":" + num(g_pos.halfmove);
    s += ",\"fullmove\":" + num(g_pos.fullmove);
    s += ",\"check\":" + std::string(check ? "true" : "false");
    s += ",\"checkSquare\":" + num(check ? to64(g_pos.kingSq[g_pos.side]) : -1);
    s += ",\"status\":\"" + std::string(statusName(st)) + "\"";

    // "winner" is only meaningful for checkmate; draws report an empty string.
    std::string winner;
    if (st == CHECKMATE) winner = (g_pos.side == WHITE) ? "b" : "w";
    s += ",\"winner\":\"" + winner + "\"";
    s += ",\"fen\":\"" + g_pos.getFEN() + "\"";

    if (!g_pos.log.empty()) {
        const LogEntry& last = g_pos.log.back();
        s += ",\"lastMove\":{\"from\":" + num(to64(last.move.from)) +
             ",\"to\":" + num(to64(last.move.to)) + "}";
    } else {
        s += ",\"lastMove\":null";
    }

    s += ",\"history\":[";
    for (size_t i = 0; i < g_pos.log.size(); ++i) {
        const LogEntry& e = g_pos.log[i];
        if (i) s += ",";
        s += "{\"san\":\"" + e.san + "\"";
        s += ",\"from\":" + num(to64(e.move.from));
        s += ",\"to\":" + num(to64(e.move.to));
        s += ",\"mover\":\"" + std::string(e.mover == WHITE ? "w" : "b") + "\"";
        s += ",\"captured\":\"" + std::string(e.captured ? std::string(1, pieceChar(e.captured)) : "") + "\"";
        s += ",\"promo\":\"" + promoLetter(e.move.promo) + "\"";
        s += ",\"castle\":" + std::string((e.move.flags & (F_KCASTLE | F_QCASTLE)) ? "true" : "false");
        s += ",\"ep\":" + std::string((e.move.flags & F_EP) ? "true" : "false");
        s += "}";
    }
    s += "]}";
    return s;
}

extern "C" {

// Trivial round-trip used to prove the C++ -> WASM -> JS pipeline works.
EMSCRIPTEN_KEEPALIVE int ce_ping(int x) { return x * 2 + 1; }

EMSCRIPTEN_KEEPALIVE void ce_new_game() {
    g_pos.setStartPosition();
    clearSearchTables();
}

EMSCRIPTEN_KEEPALIVE int ce_set_fen(const char* fen) {
    Position probe;
    if (!probe.setFEN(fen ? fen : "")) return 0;
    g_pos = probe;
    clearSearchTables();
    return 1;
}

EMSCRIPTEN_KEEPALIVE const char* ce_state() { return returnBuf(buildState()); }

EMSCRIPTEN_KEEPALIVE const char* ce_legal_moves() {
    MoveList list;
    g_pos.generateLegal(list);
    std::string s = "[";
    for (int i = 0; i < list.count; ++i) {
        const Move& m = list.m[i];
        if (i) s += ",";
        s += "{\"from\":" + num(to64(m.from)) + ",\"to\":" + num(to64(m.to));
        s += ",\"promo\":\"" + promoLetter(m.promo) + "\"";
        s += ",\"capture\":" + std::string((m.flags & F_CAPTURE) ? "true" : "false");
        s += ",\"castle\":" + std::string((m.flags & (F_KCASTLE | F_QCASTLE)) ? "true" : "false");
        s += "}";
    }
    s += "]";
    return returnBuf(s);
}

// promo: 0 = auto-queen, otherwise 2..5 (knight/bishop/rook/queen).
EMSCRIPTEN_KEEPALIVE int ce_move(int from, int to, int promo) {
    if (from < 0 || from > 63 || to < 0 || to > 63) return 0;
    return g_pos.playMove(from64(from), from64(to), promo) ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE int ce_undo() { return g_pos.undo() ? 1 : 0; }

EMSCRIPTEN_KEEPALIVE const char* ce_ai_move(int depth, int movetimeMs, int randomCp) {
    SearchLimits lim;
    lim.depth = depth;
    lim.movetimeMs = movetimeMs;
    lim.randomCp = randomCp;
    SearchResult r = search(g_pos, lim);
    if (!r.found) return returnBuf("null");
    std::string s = "{\"from\":" + num(to64(r.best.from)) + ",\"to\":" + num(to64(r.best.to));
    s += ",\"promo\":\"" + promoLetter(r.best.promo) + "\"";
    s += ",\"score\":" + num(r.score);
    s += ",\"depth\":" + num(r.depth);
    s += ",\"nodes\":" + num(r.nodes);
    s += "}";
    return returnBuf(s);
}

EMSCRIPTEN_KEEPALIVE int ce_evaluate() { return evaluate(g_pos); }

EMSCRIPTEN_KEEPALIVE double ce_perft(int depth) {
    return (double)perft(g_pos, depth);
}

}  // extern "C"
