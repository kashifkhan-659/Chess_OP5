#pragma once

#include "chess.hpp"

namespace chess {

struct SearchLimits {
    int depth = 4;
    int movetimeMs = 2000;
    int randomCp = 0;  // pick randomly among root moves within this many centipawns
};

struct SearchResult {
    Move best;
    int score = 0;
    long nodes = 0;
    int depth = 0;
    bool found = false;
};

int evaluate(const Position& pos);
SearchResult search(Position& pos, const SearchLimits& limits);
void clearSearchTables();

}  // namespace chess
