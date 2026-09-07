// Turns a bounded window of recent FINALIZED games into per-player
// rotation history: how many recent quarters they've played in each broad
// role, in each exact position, and how many recent quarters they've spent
// on the bench. soccerScheduling.js uses this only to break ties among
// candidates who are already equally eligible under the existing
// availability/fairness/suitability rules — see the "suitability
// tolerance" comment there for how the two interact.
//
// Deliberately pure and I/O-free: callers (soccerLineupHistory.js) are
// responsible for loading the raw game records and handing them here.
// Only ever counts games with status 'finalized' AND a real selected
// draft — a draft that was generated but never chosen, or a game a coach
// hasn't finalized yet, contributes nothing, no matter how many times it
// was regenerated. A player who isn't mentioned anywhere in a counted
// game's stored result (removed from the roster since, or simply wasn't
// part of that game) is never touched for that game — there's no way for
// a "missed game" to look like a bench appearance, because nothing ever
// iterates the CURRENT roster to backfill absentees; only what a game's
// own stored result actually recorded is ever counted.

const DEFAULT_HISTORY_WINDOW = 4;
const ROLE_KEYS = ['goalkeeper', 'defender', 'midfielder', 'forward'];

function emptyPlayerStats() {
  return {
    roleCounts: { goalkeeper: 0, defender: 0, midfielder: 0, forward: 0 },
    positionCounts: {},
    benchCount: 0,
    gamesCounted: 0,
  };
}

// Most-recent-first by game date (a plain "YYYY-MM-DD" string, which sorts
// correctly lexically), tie-broken by finalizedAt so two games logged the
// same day stay in a stable, deterministic order. Only ever looks at
// finalized games with an actual selected draft on record — anything else
// (an in-progress draft, a game whose selection somehow got cleared) is
// excluded rather than guessed at.
function selectRecentFinalizedGames(games, windowSize = DEFAULT_HISTORY_WINDOW) {
  return [...(games || [])]
    .filter((g) => g && g.status === 'finalized' && g.selectedDraftId && g.drafts && g.drafts[g.selectedDraftId]?.result)
    .sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return (a.finalizedAt || '') < (b.finalizedAt || '') ? 1 : -1;
    })
    .slice(0, Math.max(0, windowSize));
}

// Builds the stats structure soccerScheduling.js's rotation tie-break
// reads from. `games` is the account's full list of stored game records
// (see soccerLineupHistory.js); only the most recent `windowSize`
// finalized ones actually contribute. Stored results reference players by
// id only (never a name), matching every other history-adjacent structure
// in this app.
function buildRotationStats(games, { windowSize = DEFAULT_HISTORY_WINDOW } = {}) {
  const recentGames = selectRecentFinalizedGames(games, windowSize);
  const statsByPlayerId = new Map();
  const statsFor = (id) => {
    if (!statsByPlayerId.has(id)) statsByPlayerId.set(id, emptyPlayerStats());
    return statsByPlayerId.get(id);
  };

  for (const game of recentGames) {
    const result = game.drafts[game.selectedDraftId].result;
    const countedThisGame = new Set();
    for (const q of result.quarters || []) {
      for (const slot of q.lineup || []) {
        if (!slot.playerId) continue;
        const s = statsFor(slot.playerId);
        if (ROLE_KEYS.includes(slot.role)) s.roleCounts[slot.role] += 1;
        s.positionCounts[slot.position] = (s.positionCounts[slot.position] || 0) + 1;
        countedThisGame.add(slot.playerId);
      }
      for (const benchId of q.bench || []) {
        statsFor(benchId).benchCount += 1;
        countedThisGame.add(benchId);
      }
    }
    for (const id of countedThisGame) statsFor(id).gamesCounted += 1;
  }

  return { windowSize, gamesConsidered: recentGames.length, statsByPlayerId };
}

// Lower is "fresher" (more preferred for rotation). A player never seen in
// the counted window (brand new, or simply hasn't played this role/position
// recently) scores 0 — the neutral, most-eligible score — so new players
// and players with no history work normally rather than being penalized
// for having no data. Recent time on the bench actively LOWERS the score
// (floored at 0), since handing this player a slot now is exactly how
// bench timing gets varied instead of the same player always sitting.
function rotationScoreFor(playerId, role, positionId, stats) {
  const s = stats.statsByPlayerId.get(playerId);
  if (!s) return 0;
  const roleCount = s.roleCounts[role] || 0;
  const positionCount = s.positionCounts[positionId] || 0;
  return Math.max(0, roleCount + positionCount - s.benchCount);
}

// Converts a rotation score into a selection weight for prng.js's
// weightedPick: fresher (lower score) -> higher weight -> more likely to
// be picked, but never impossible for a less-fresh candidate to win — this
// is a bias, not a hard rule, which is what keeps a fixed roster from
// producing a mechanically repetitive "always rotate in strict order"
// pattern. `rotationBoost` (default 1) sharpens the bias for a temporary
// "rotate more than last game" request without touching which candidates
// are eligible in the first place (see soccerScheduling.js's suitability
// tolerance) — it only ever changes relative PROBABILITY among an already
//-fixed, already-eligible pool.
function rotationWeight(score, rotationBoost = 1) {
  return 1 / (1 + score * Math.max(0, rotationBoost));
}

module.exports = {
  DEFAULT_HISTORY_WINDOW,
  selectRecentFinalizedGames,
  buildRotationStats,
  rotationScoreFor,
  rotationWeight,
};
