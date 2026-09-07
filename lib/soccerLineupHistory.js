// Private, per-account storage for Soccer Lineup game drafts and finalized
// games — separate from roster.json (lib/soccerLineup.js), same private
// data area, same atomic-write/lock/account-isolation guarantees. This is
// the ONE place that actually calls computeGameLineup with a seed; every
// other caller (chat, the roster-panel-adjacent REST routes) goes through
// the functions here rather than calling soccerScheduling.js directly, so
// "a draft" always means a real, persisted, reopenable record.
//
// Core idea that makes finalize/replace/undo/idempotency all fall out for
// free: a game has AT MOST one "selected" draft at a time (`selectedDraftId`).
// Rotation history is never incrementally accumulated anywhere — it's
// recomputed fresh, every time it's needed, by reading only the games
// whose `status === 'finalized'` and looking at `drafts[selectedDraftId]`.
// That means replacing which draft is selected for an already-finalized
// game automatically replaces its contribution (no separate bookkeeping to
// keep in sync), un-finalizing a game automatically removes its
// contribution, and finalizing the same draft twice does nothing the
// second time.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const privateData = require('./privateData');
const scheduling = require('./soccerScheduling');
const rotationStatsLib = require('./soccerRotationStats');

const MAX_ALTERNATIVE_ATTEMPTS = 5;

class LineupHistoryError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

let lineupDirCache = null;
function getLineupDir() {
  if (!lineupDirCache) {
    lineupDirCache = path.join(privateData.resolvePrivateDataDir(), 'lineups');
  }
  return lineupDirCache;
}

function initLineupHistoryStorage() {
  privateData.ensurePrivateDir(getLineupDir());
}

function safeFileNameFor(username) {
  return String(username).replace(/[^a-zA-Z0-9_-]/g, '_') || 'default';
}

function gamesFilePath(username) {
  return path.join(getLineupDir(), `${safeFileNameFor(username)}.json`);
}

function isValidGamesShape(parsed) {
  return !!parsed && typeof parsed === 'object' && !!parsed.games && typeof parsed.games === 'object';
}

// Same discriminated-result pattern as soccerLineup.js's loadRosterResult —
// 'missing' (nothing saved yet) must never be treated the same as
// 'invalid'/'error', so a read failure can't look like "no games yet" and
// get silently overwritten.
function loadGamesResult(username) {
  const file = gamesFilePath(username);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { status: 'missing', data: null };
    return { status: 'error', data: null, error: (err && err.code) || 'read-failed' };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'invalid', data: null, error: 'invalid-json' };
  }
  if (!isValidGamesShape(parsed)) {
    return { status: 'invalid', data: null, error: 'missing-games-object' };
  }
  return { status: 'ok', data: parsed };
}

// Convenience wrapper: an empty store for a genuinely new account, or
// throws for anything else (corrupt file, permission error) — the same
// policy loadRoster() uses, for the same reason: a read failure must never
// be treated as "empty" and risk a caller overwriting real history.
function loadGames(username) {
  const result = loadGamesResult(username);
  if (result.status === 'ok') return result.data;
  if (result.status === 'missing') return { games: {} };
  const err = new LineupHistoryError('LINEUP_HISTORY_UNREADABLE', `Lineup history for this account exists but could not be read (${result.error}).`);
  throw err;
}

function saveGames(username, data) {
  privateData.ensurePrivateDir(getLineupDir());
  const file = gamesFilePath(username);
  privateData.atomicWriteFileSync(file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

// Independent lock map from roster.js's — this is a different file, and a
// lineup-history save should never wait on an unrelated roster edit (or
// vice versa).
const lineupLocks = new Map();
function withLineupLock(username, fn) {
  const tail = lineupLocks.get(username) || Promise.resolve();
  const result = tail.then(fn, fn);
  lineupLocks.set(username, result.catch(() => {}));
  return result;
}

// A short, stable fingerprint of the roster's identity + ratings — used
// only to detect drift ("did the live roster change since this draft was
// frozen?"), never as a security boundary. Order-independent (sorted by
// id) so re-saving the roster file without any real change never falsely
// flags drift.
function computeRosterVersion(roster) {
  const normalized = [...roster.players]
    .map((p) => ({ id: p.id, name: p.name, skills: p.skills }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 16);
}

function rosterSnapshotFrom(roster) {
  return roster.players.map((p) => ({ id: p.id, name: p.name, skills: { ...p.skills } }));
}

// Reconstructs a roster-shaped object from a game's FROZEN inputs, so
// regenerating an alternative (or refreshing) schedules against exactly
// the roster/settings that were in effect when the game was first created
// — never whatever the live roster happens to be now. This is what makes
// "generate another option" never silently change the input.
function rosterFromFrozenInputs(frozenInputs) {
  return {
    formation: frozenInputs.formation,
    sidePreferences: frozenInputs.sidePreferencesSnapshot,
    players: frozenInputs.rosterSnapshot.map((p) => ({ id: p.id, name: p.name, skills: { ...p.skills } })),
  };
}

// Map <-> plain object, so a rotation-stats snapshot can round-trip
// through JSON storage while still being usable by
// soccerRotationStats.rotationScoreFor (which expects a Map).
function serializeRotationStats(stats) {
  return {
    windowSize: stats.windowSize,
    gamesConsidered: stats.gamesConsidered,
    statsByPlayerId: Object.fromEntries(stats.statsByPlayerId),
  };
}
function deserializeRotationStats(snapshot) {
  return {
    windowSize: snapshot.windowSize,
    gamesConsidered: snapshot.gamesConsidered,
    statsByPlayerId: new Map(Object.entries(snapshot.statsByPlayerId || {})),
  };
}

// Reduces a live computeGameLineup() result (which references real player
// OBJECTS) down to the id-only shape this module persists — the private
// file still holds real names (via rosterSnapshot, same as roster.json
// already does), but never duplicates them inside every quarter/bench
// entry; there's exactly one place a name lives, so a later rename can
// never leave a stale copy behind.
function serializeResult(result) {
  return {
    formation: result.formation,
    quarters: result.quarters.map((q) => ({
      quarter: q.quarter,
      lineup: q.lineup.map((s) => ({ position: s.position, role: s.role, playerId: s.player ? s.player.id : null, pinKind: s.pinKind })),
      bench: q.bench.map((p) => p.id),
    })),
    quartersPlayedSummary: result.quartersPlayedSummary.map((e) => ({ id: e.id, quartersPlayed: e.quartersPlayed })),
    sidePreferencesApplied: result.sidePreferencesApplied,
    rotationInfluenced: result.rotationInfluenced,
    warnings: result.warnings,
  };
}

// The inverse of serializeResult: rebuilds real player object references
// from ids, using `playersById` (built from the CURRENT roster with a
// fallback to the game's own rosterSnapshot for a player who's since been
// removed, so a historical game never breaks just because someone left
// the team). Produces exactly the shape soccerLineup.formatGameLineupResult
// / soccerPrivacy.formatGameLineupResultAnonymized already expect, so
// reopening a saved game can reuse those formatters unchanged.
function hydrateResult(storedResult, playersById) {
  const resolve = (id) => (id ? playersById.get(id) || { id, name: '(removed player)', skills: {} } : null);
  return {
    formation: storedResult.formation,
    quarters: storedResult.quarters.map((q) => ({
      quarter: q.quarter,
      lineup: q.lineup.map((s) => ({ position: s.position, role: s.role, player: resolve(s.playerId), pinKind: s.pinKind })),
      bench: q.bench.map((id) => resolve(id)).filter(Boolean),
    })),
    quartersPlayedSummary: storedResult.quartersPlayedSummary.map((e) => ({
      id: e.id,
      name: (playersById.get(e.id) || { name: '(removed player)' }).name,
      quartersPlayed: e.quartersPlayed,
    })),
    sidePreferencesApplied: storedResult.sidePreferencesApplied,
    rotationInfluenced: storedResult.rotationInfluenced,
    warnings: storedResult.warnings,
  };
}

function playersByIdFor(game, currentRoster) {
  const map = new Map();
  for (const p of game.frozenInputs.rosterSnapshot) map.set(p.id, p);
  if (currentRoster) for (const p of currentRoster.players) map.set(p.id, p); // live data wins (current name/ratings)
  return map;
}

// True when two stored results assign the same player (or nobody) to
// every exact slot in every quarter — the definition of "not a meaningfully
// different alternative" used by the bounded regeneration retry below.
function resultsAreEquivalent(a, b) {
  if (a.quarters.length !== b.quarters.length) return false;
  for (let i = 0; i < a.quarters.length; i++) {
    const qa = a.quarters[i].lineup;
    const qb = b.quarters[i].lineup;
    if (qa.length !== qb.length) return false;
    const byPositionA = new Map(qa.map((s) => [s.position, s.playerId]));
    for (const s of qb) {
      if (byPositionA.get(s.position) !== s.playerId) return false;
    }
  }
  return true;
}

function newGameId() {
  return crypto.randomUUID();
}
function newDraftId() {
  return crypto.randomUUID();
}
function newSeed() {
  // The seed itself is chosen with real randomness once, then recorded —
  // from then on, reproducing this exact draft only ever needs the
  // recorded seed, never fresh randomness again.
  return crypto.randomUUID();
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

// Builds a brand-new game + its first draft. Must be called from inside
// withLineupLock (every exported mutating function below documents this).
// `roster` is the LIVE roster — its identity/settings are frozen into
// `frozenInputs` right now, and every later option/regeneration for this
// game reuses that frozen snapshot rather than the live roster.
function buildNewGame(existingGamesData, roster, options = {}) {
  const {
    date = todayIsoDate(),
    formation,
    resting = {},
    pinned = {},
    sideOverrides = {},
    ignoreSidePreferences = false,
    rotationBoost = 1,
    historyWindow,
  } = options;

  const gameId = newGameId();
  const rotationStatsData = rotationStatsLib.buildRotationStats(Object.values(existingGamesData.games), {
    windowSize: historyWindow ?? rotationStatsLib.DEFAULT_HISTORY_WINDOW,
  });
  const seed = newSeed();
  const result = scheduling.computeGameLineup(roster, {
    formation,
    resting,
    pinned,
    sideOverrides,
    ignoreSidePreferences,
    seed,
    rotationStatsData,
    rotationBoost,
  });

  const draftId = newDraftId();
  const nowIso = new Date().toISOString();
  const game = {
    gameId,
    date,
    status: 'draft',
    createdAt: nowIso,
    finalizedAt: null,
    selectedDraftId: draftId,
    draftOrder: [draftId],
    frozenInputs: {
      rosterVersion: computeRosterVersion(roster),
      rosterSnapshot: rosterSnapshotFrom(roster),
      formation: result.formation,
      constraints: { resting, pinned, sideOverrides, ignoreSidePreferences },
      sidePreferencesSnapshot: roster.sidePreferences || {},
      historyWindow: rotationStatsData.windowSize,
      rotationStatsSnapshot: serializeRotationStats(rotationStatsData),
    },
    drafts: {
      [draftId]: {
        draftId,
        seed,
        createdAt: nowIso,
        rotationBoost,
        distinctFromPrevious: true,
        result: serializeResult(result),
      },
    },
  };
  return game;
}

// Public: create a new game + first draft for the given (live) roster.
// Caller must already hold withLineupLock for this username.
function createGame(username, roster, options = {}) {
  const data = loadGames(username);
  const game = buildNewGame(data, roster, options);
  data.games[game.gameId] = game;
  saveGames(username, data);
  return game;
}

// Public: "generate another option" — a new seed, the SAME frozen roster
// snapshot/constraints/settings/history this game started with. Tries up
// to MAX_ALTERNATIVE_ATTEMPTS distinct seeds looking for a result that
// isn't identical to any option already generated for this game; if none
// turns up, the last attempt is kept and `distinctFromPrevious: false` is
// recorded so the caller can explain rather than overpromise. Caller must
// already hold withLineupLock for this username.
function addAlternative(username, gameId, options = {}) {
  const { rotationBoost = 1 } = options;
  const data = loadGames(username);
  const game = data.games[gameId];
  if (!game) throw new LineupHistoryError('GAME_NOT_FOUND', 'No saved game matches that id.');

  const syntheticRoster = rosterFromFrozenInputs(game.frozenInputs);
  const rotationStatsData = deserializeRotationStats(game.frozenInputs.rotationStatsSnapshot);
  const previousResults = game.draftOrder.map((id) => game.drafts[id].result);

  let attemptResult = null;
  let attemptSeed = null;
  let distinct = false;
  for (let attempt = 0; attempt < MAX_ALTERNATIVE_ATTEMPTS; attempt++) {
    const seed = newSeed();
    const result = serializeResult(
      scheduling.computeGameLineup(syntheticRoster, {
        formation: game.frozenInputs.formation,
        ...game.frozenInputs.constraints,
        seed,
        rotationStatsData,
        rotationBoost,
      })
    );
    attemptResult = result;
    attemptSeed = seed;
    distinct = !previousResults.some((prev) => resultsAreEquivalent(prev, result));
    if (distinct) break;
  }

  const draftId = newDraftId();
  const nowIso = new Date().toISOString();
  game.drafts[draftId] = {
    draftId,
    seed: attemptSeed,
    createdAt: nowIso,
    rotationBoost,
    distinctFromPrevious: distinct,
    result: attemptResult,
  };
  game.draftOrder.push(draftId);
  game.selectedDraftId = draftId;
  // A freshly generated, not-yet-reviewed option must never silently
  // count as "what was actually played" — if this game was already
  // finalized, generating another option here reverts it to a draft so it
  // stops contributing to rotation until the coach explicitly finalizes
  // again (possibly this very draft, possibly the old one, via an
  // explicit draftId).
  if (game.status === 'finalized') {
    game.status = 'draft';
    game.finalizedAt = null;
  }
  saveGames(username, data);
  return { game, draftId, distinctFromPrevious: distinct };
}

// Public: mark a draft as the game's finalized, played lineup. Idempotent
// — finalizing the same (gameId, draftId) pair again is a no-op that
// leaves finalizedAt untouched. Finalizing a DIFFERENT draft for an
// already-finalized game replaces which draft counts (see file header) —
// never appends a second game's worth of history. Caller must already
// hold withLineupLock for this username.
function finalizeGame(username, gameId, options = {}) {
  const data = loadGames(username);
  const game = data.games[gameId];
  if (!game) throw new LineupHistoryError('GAME_NOT_FOUND', 'No saved game matches that id.');
  const targetDraftId = options.draftId || game.selectedDraftId;
  if (!targetDraftId || !game.drafts[targetDraftId]) {
    throw new LineupHistoryError('DRAFT_NOT_FOUND', 'No saved option matches that id for this game.');
  }
  if (game.status === 'finalized' && game.selectedDraftId === targetDraftId) {
    return { game, alreadyFinalized: true };
  }
  game.status = 'finalized';
  game.finalizedAt = new Date().toISOString();
  game.selectedDraftId = targetDraftId;
  saveGames(username, data);
  return { game, alreadyFinalized: false };
}

// Public: undo finalization — the game (and whichever draft was selected)
// goes back to being a draft, which means it stops contributing to
// rotation the moment this saves (stats are always recomputed fresh, per
// the file header). Idempotent: unfinalizing an already-draft game is a
// no-op. Caller must already hold withLineupLock for this username.
function unfinalizeGame(username, gameId) {
  const data = loadGames(username);
  const game = data.games[gameId];
  if (!game) throw new LineupHistoryError('GAME_NOT_FOUND', 'No saved game matches that id.');
  if (game.status !== 'finalized') return { game, alreadyDraft: true };
  game.status = 'draft';
  game.finalizedAt = null;
  saveGames(username, data);
  return { game, alreadyDraft: false };
}

// Public: explicit "the roster changed, start this game over with current
// data" action — never silent. Creates a brand-new game (new gameId) from
// the LIVE roster, reusing the old game's date/constraints unless
// overridden; the stale game record is left exactly as it was (still
// reachable, just no longer the active one for this date). Caller must
// already hold withLineupLock for this username.
function refreshGame(username, gameId, roster, overrides = {}) {
  const data = loadGames(username);
  const staleGame = data.games[gameId];
  if (!staleGame) throw new LineupHistoryError('GAME_NOT_FOUND', 'No saved game matches that id.');
  const game = buildNewGame(data, roster, {
    date: overrides.date ?? staleGame.date,
    formation: overrides.formation ?? staleGame.frozenInputs.formation,
    resting: overrides.resting ?? staleGame.frozenInputs.constraints.resting,
    pinned: overrides.pinned ?? staleGame.frozenInputs.constraints.pinned,
    sideOverrides: overrides.sideOverrides ?? staleGame.frozenInputs.constraints.sideOverrides,
    ignoreSidePreferences: overrides.ignoreSidePreferences ?? staleGame.frozenInputs.constraints.ignoreSidePreferences,
    rotationBoost: overrides.rotationBoost ?? 1,
    historyWindow: staleGame.frozenInputs.historyWindow,
  });
  data.games[game.gameId] = game;
  saveGames(username, data);
  return { game, refreshedFromGameId: gameId };
}

// Read-only: hydrates a stored game for display/reopening/export — never
// recomputes anything. `currentRoster` (optional) supplies live names for
// display and lets rosterChanged be detected; omit it to just read the
// frozen snapshot as-is.
function getGame(username, gameId, currentRoster = null) {
  const data = loadGames(username);
  const game = data.games[gameId];
  if (!game) throw new LineupHistoryError('GAME_NOT_FOUND', 'No saved game matches that id.');
  const playersById = playersByIdFor(game, currentRoster);
  const rosterChanged = currentRoster ? computeRosterVersion(currentRoster) !== game.frozenInputs.rosterVersion : false;
  const drafts = {};
  for (const [id, draft] of Object.entries(game.drafts)) {
    drafts[id] = { ...draft, result: hydrateResult(draft.result, playersById) };
  }
  return { ...game, drafts, rosterChanged };
}

function listGames(username, { limit = 50 } = {}) {
  const data = loadGames(username);
  return Object.values(data.games)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (a.createdAt < b.createdAt ? 1 : -1)))
    .slice(0, Math.max(0, limit))
    .map((g) => ({ gameId: g.gameId, date: g.date, status: g.status, createdAt: g.createdAt, finalizedAt: g.finalizedAt, selectedDraftId: g.selectedDraftId }));
}

module.exports = {
  LineupHistoryError,
  MAX_ALTERNATIVE_ATTEMPTS,
  getLineupDir,
  initLineupHistoryStorage,
  loadGamesResult,
  loadGames,
  saveGames,
  withLineupLock,
  computeRosterVersion,
  hydrateResult,
  playersByIdFor,
  createGame,
  addAlternative,
  finalizeGame,
  unfinalizeGame,
  refreshGame,
  getGame,
  listGames,
};
