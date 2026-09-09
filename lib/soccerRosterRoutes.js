// The roster panel's REST API — no LLM involved anywhere in this file.
// Every route is scoped to req.session.username, and every read/write goes
// through withRosterLock so a panel edit can never race a chat-driven edit
// (or another panel tab) into a lost update. Split out of server.js per
// CLAUDE.md's guidance to keep that file under ~500 lines.
const express = require('express');
const soccerLineup = require('./soccerLineup');

function requireAuth(req, res, next) {
  if (req.session && req.session.loggedIn) return next();
  return res.status(401).json({ ok: false, error: 'Not authenticated' });
}

const router = express.Router();

// "Saved on this Mac" is only accurate when the server really is running on
// macOS — anywhere else it's just wrong, so the wording is chosen from the
// actual runtime platform rather than assumed.
function storageNote() {
  const where = process.platform === 'darwin' ? 'on this Mac' : 'on this computer';
  return `Saved ${where}, in a private folder outside the RayGPT project folder — never in the git repository.`;
}

router.get('/roster', requireAuth, (req, res) => {
  let roster;
  try {
    roster = soccerLineup.loadRoster(req.session.username);
  } catch {
    return res.status(500).json({ ok: false, error: 'Your roster file exists but could not be read.' });
  }
  res.json({
    ok: true,
    roster: roster || { formation: soccerLineup.DEFAULT_FORMATION, players: [], sidePreferences: soccerLineup.DEFAULT_SIDE_PREFERENCES },
    storageNote: storageNote(),
  });
});

// Side preferences and formation are settings, not roster content — this
// never involves the model at all, same as the rest of this file. Only
// the roles present in the request body change; anything omitted keeps
// its current saved value (see soccerLineup.applyLineupSettings). formation
// is only applied when present at all, since (unlike a side preference)
// there's no "none" — every roster always has one.
router.put('/roster/settings', requireAuth, async (req, res) => {
  const { defender, midfielder, forward, formation } = req.body || {};
  try {
    const result = await soccerLineup.withRosterLock(req.session.username, async () => {
      let roster;
      try {
        roster = soccerLineup.loadRoster(req.session.username);
      } catch {
        throw new Error('ROSTER_UNREADABLE');
      }
      const rosterForEdit = roster || { formation: soccerLineup.DEFAULT_FORMATION, players: [] };
      soccerLineup.applyLineupSettings(rosterForEdit, { defender, midfielder, forward });
      if (formation !== undefined) soccerLineup.applyFormationSetting(rosterForEdit, formation);
      soccerLineup.saveRoster(req.session.username, rosterForEdit);
      return { sidePreferences: rosterForEdit.sidePreferences, formation: rosterForEdit.formation };
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof soccerLineup.RosterValidationError) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    if (err.message === 'ROSTER_UNREADABLE') {
      return res.status(500).json({ ok: false, error: 'Your roster file exists but could not be read.' });
    }
    res.status(500).json({ ok: false, error: 'Could not save the settings change — please try again.' });
  }
});

router.post('/roster/players', requireAuth, async (req, res) => {
  const { name, offense, defense, goalie } = req.body || {};
  try {
    const player = await soccerLineup.withRosterLock(req.session.username, async () => {
      let roster;
      try {
        roster = soccerLineup.loadRoster(req.session.username);
      } catch {
        throw new Error('ROSTER_UNREADABLE');
      }
      const rosterForEdit = roster || { formation: soccerLineup.DEFAULT_FORMATION, players: [] };
      const added = soccerLineup.addPlayerDirect(rosterForEdit, { name, offense, defense, goalie });
      soccerLineup.saveRoster(req.session.username, rosterForEdit);
      return added;
    });
    res.json({ ok: true, player });
  } catch (err) {
    if (err instanceof soccerLineup.RosterValidationError) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    if (err.message === 'ROSTER_UNREADABLE') {
      return res.status(500).json({ ok: false, error: 'Your roster file exists but could not be read.' });
    }
    res.status(500).json({ ok: false, error: 'Could not save the roster change — please try again.' });
  }
});

router.put('/roster/players/:id', requireAuth, async (req, res) => {
  const { name, offense, defense, goalie } = req.body || {};
  try {
    const player = await soccerLineup.withRosterLock(req.session.username, async () => {
      let roster;
      try {
        roster = soccerLineup.loadRoster(req.session.username);
      } catch {
        throw new Error('ROSTER_UNREADABLE');
      }
      if (!roster) throw new Error('NOT_FOUND');
      const updated = soccerLineup.updatePlayerDirect(roster, req.params.id, { name, offense, defense, goalie });
      if (!updated) throw new Error('NOT_FOUND');
      soccerLineup.saveRoster(req.session.username, roster);
      return updated;
    });
    res.json({ ok: true, player });
  } catch (err) {
    if (err instanceof soccerLineup.RosterValidationError) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    if (err.message === 'NOT_FOUND') return res.status(404).json({ ok: false, error: 'Player not found.' });
    if (err.message === 'ROSTER_UNREADABLE') {
      return res.status(500).json({ ok: false, error: 'Your roster file exists but could not be read.' });
    }
    res.status(500).json({ ok: false, error: 'Could not save the roster change — please try again.' });
  }
});

router.delete('/roster/players/:id', requireAuth, async (req, res) => {
  try {
    const removed = await soccerLineup.withRosterLock(req.session.username, async () => {
      let roster;
      try {
        roster = soccerLineup.loadRoster(req.session.username);
      } catch {
        throw new Error('ROSTER_UNREADABLE');
      }
      if (!roster) throw new Error('NOT_FOUND');
      const deleted = soccerLineup.removePlayerDirect(roster, req.params.id);
      if (!deleted) throw new Error('NOT_FOUND');
      soccerLineup.saveRoster(req.session.username, roster);
      return deleted;
    });
    res.json({ ok: true, removedId: removed.id });
  } catch (err) {
    if (err.message === 'NOT_FOUND') return res.status(404).json({ ok: false, error: 'Player not found.' });
    if (err.message === 'ROSTER_UNREADABLE') {
      return res.status(500).json({ ok: false, error: 'Your roster file exists but could not be read.' });
    }
    res.status(500).json({ ok: false, error: 'Could not save the roster change — please try again.' });
  }
});

module.exports = router;
