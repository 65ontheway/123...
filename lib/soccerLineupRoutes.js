// REST API for Soccer Lineup game drafts/finalization — no LLM involved
// anywhere in this file, same as soccerRosterRoutes.js. Exists so the
// "Generate another option" / "Mark used" buttons on a lineup card can act
// directly without another model round trip: the model's job (via chat) is
// creating the FIRST draft for a request and explaining results; these
// routes are what a button click actually calls.
const express = require('express');
const soccerLineup = require('./soccerLineup');
const soccerFormations = require('./soccerFormations');
const history = require('./soccerLineupHistory');

function requireAuth(req, res, next) {
  if (req.session && req.session.loggedIn) return next();
  return res.status(401).json({ ok: false, error: 'Not authenticated' });
}

const router = express.Router();

function loadRosterOr500(req, res) {
  try {
    return soccerLineup.loadRoster(req.session.username) || { formation: soccerLineup.DEFAULT_FORMATION, players: [] };
  } catch {
    res.status(500).json({ ok: false, error: 'Your roster file exists but could not be read.' });
    return null;
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function normalizeCreateOptions(body = {}) {
  const options = {};
  if (typeof body.date === 'string' && DATE_RE.test(body.date)) options.date = body.date;
  if (typeof body.formation === 'string' && soccerFormations.FORMATIONS[body.formation]) options.formation = body.formation;
  if (body.resting && typeof body.resting === 'object') options.resting = body.resting;
  if (body.pinned && typeof body.pinned === 'object') options.pinned = body.pinned;
  if (body.sideOverrides && typeof body.sideOverrides === 'object') options.sideOverrides = body.sideOverrides;
  if (body.ignoreSidePreferences != null) options.ignoreSidePreferences = !!body.ignoreSidePreferences;
  if (body.rotationBoost != null) options.rotationBoost = clampRotationBoost(body.rotationBoost);
  return options;
}

// Keeps a bad/huge client-supplied value from producing NaN or absurd
// selection weights — bounded to a sane range, default 1 (no boost).
function clampRotationBoost(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1;
  return Math.min(5, Math.max(0.1, n));
}

function respondWithGame(res, game, extra = {}) {
  res.json({ ok: true, game, ...extra });
}

router.get('/games', requireAuth, (req, res) => {
  try {
    res.json({ ok: true, games: history.listGames(req.session.username) });
  } catch (err) {
    if (err instanceof history.LineupHistoryError) {
      return res.status(500).json({ ok: false, error: 'Your saved lineups could not be read.' });
    }
    res.status(500).json({ ok: false, error: 'Could not load saved lineups.' });
  }
});

router.get('/games/:gameId', requireAuth, (req, res) => {
  const roster = loadRosterOr500(req, res);
  if (!roster) return;
  try {
    const game = history.getGame(req.session.username, req.params.gameId, roster);
    respondWithGame(res, game);
  } catch (err) {
    if (err instanceof history.LineupHistoryError && err.code === 'GAME_NOT_FOUND') {
      return res.status(404).json({ ok: false, error: 'No saved game matches that id.' });
    }
    res.status(500).json({ ok: false, error: 'Could not load that saved lineup.' });
  }
});

router.post('/games', requireAuth, async (req, res) => {
  const roster = loadRosterOr500(req, res);
  if (!roster) return;
  try {
    const created = await history.withLineupLock(req.session.username, () =>
      history.createGame(req.session.username, roster, normalizeCreateOptions(req.body))
    );
    const game = history.getGame(req.session.username, created.gameId, roster);
    respondWithGame(res, game);
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Could not generate a lineup — please try again.' });
  }
});

router.post('/games/:gameId/alternative', requireAuth, async (req, res) => {
  const roster = loadRosterOr500(req, res);
  if (!roster) return;
  try {
    const rotationBoost = req.body?.rotationBoost != null ? clampRotationBoost(req.body.rotationBoost) : 1;
    const { distinctFromPrevious } = await history.withLineupLock(req.session.username, () =>
      history.addAlternative(req.session.username, req.params.gameId, { rotationBoost })
    );
    const game = history.getGame(req.session.username, req.params.gameId, roster);
    respondWithGame(res, game, { distinctFromPrevious });
  } catch (err) {
    if (err instanceof history.LineupHistoryError && err.code === 'GAME_NOT_FOUND') {
      return res.status(404).json({ ok: false, error: 'No saved game matches that id.' });
    }
    res.status(500).json({ ok: false, error: 'Could not generate another option — please try again.' });
  }
});

router.post('/games/:gameId/finalize', requireAuth, async (req, res) => {
  const roster = loadRosterOr500(req, res);
  if (!roster) return;
  try {
    const draftId = typeof req.body?.draftId === 'string' ? req.body.draftId : undefined;
    const { alreadyFinalized } = await history.withLineupLock(req.session.username, () =>
      history.finalizeGame(req.session.username, req.params.gameId, { draftId })
    );
    const game = history.getGame(req.session.username, req.params.gameId, roster);
    respondWithGame(res, game, { alreadyFinalized });
  } catch (err) {
    if (err instanceof history.LineupHistoryError && (err.code === 'GAME_NOT_FOUND' || err.code === 'DRAFT_NOT_FOUND')) {
      return res.status(404).json({ ok: false, error: err.code === 'GAME_NOT_FOUND' ? 'No saved game matches that id.' : 'No saved option matches that id for this game.' });
    }
    res.status(500).json({ ok: false, error: 'Could not mark that lineup used — please try again.' });
  }
});

router.post('/games/:gameId/unfinalize', requireAuth, async (req, res) => {
  const roster = loadRosterOr500(req, res);
  if (!roster) return;
  try {
    await history.withLineupLock(req.session.username, () => history.unfinalizeGame(req.session.username, req.params.gameId));
    const game = history.getGame(req.session.username, req.params.gameId, roster);
    respondWithGame(res, game);
  } catch (err) {
    if (err instanceof history.LineupHistoryError && err.code === 'GAME_NOT_FOUND') {
      return res.status(404).json({ ok: false, error: 'No saved game matches that id.' });
    }
    res.status(500).json({ ok: false, error: 'Could not undo finalization — please try again.' });
  }
});

// Explicit "the roster changed, start over with current data" action —
// the game/draft this is called on is never mutated; a brand-new game is
// created and returned instead (see soccerLineupHistory.refreshGame).
router.post('/games/:gameId/refresh', requireAuth, async (req, res) => {
  const roster = loadRosterOr500(req, res);
  if (!roster) return;
  try {
    const overrides = normalizeCreateOptions(req.body);
    const { game: created, refreshedFromGameId } = await history.withLineupLock(req.session.username, () =>
      history.refreshGame(req.session.username, req.params.gameId, roster, overrides)
    );
    const game = history.getGame(req.session.username, created.gameId, roster);
    respondWithGame(res, game, { refreshedFromGameId });
  } catch (err) {
    if (err instanceof history.LineupHistoryError && err.code === 'GAME_NOT_FOUND') {
      return res.status(404).json({ ok: false, error: 'No saved game matches that id.' });
    }
    res.status(500).json({ ok: false, error: 'Could not refresh that lineup — please try again.' });
  }
});

module.exports = router;
