// The roster panel's REST API — no LLM involved anywhere in this file.
// Every route is scoped to req.session.username, and every read/write goes
// through withRosterLock so a panel edit can never race a chat-driven edit
// (or another panel tab) into a lost update. Split out of server.js per
// CLAUDE.md's guidance to keep that file under ~500 lines.
const crypto = require('crypto');
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

// Downloadable copy of the exact shape the roster is stored in
// (formation/players, nested skills) — the same shape /roster/import below
// expects back, so "download, then re-upload" always round-trips. A file,
// not JSON in the page, because this exists specifically for a coach to
// save outside the app (their own device, cloud drive) against exactly the
// class of failure that prompted it: this app's only copy of the roster
// living on one server with no other backup.
router.get('/roster/export', requireAuth, (req, res) => {
  let roster;
  try {
    roster = soccerLineup.loadRoster(req.session.username);
  } catch {
    return res.status(500).json({ ok: false, error: 'Your roster file exists but could not be read.' });
  }
  if (!roster) roster = { formation: soccerLineup.DEFAULT_FORMATION, players: [] };
  const date = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="roster-backup-${date}.json"`);
  res.send(JSON.stringify(roster, null, 2));
});

// Wholesale replace, not merge — a restore is meant to put the roster back
// exactly as a prior export captured it, including which players are GONE
// (present in the current roster but not the backup). Every player gets a
// fresh id server-side rather than trusting whatever the uploaded file
// carries (never assume a client-supplied id is unique, or even really an
// id) — safe either way, since nothing else references these ids until
// after this response, and the panel/chat re-fetch afterward. Side
// preferences are deliberately NOT restored here (only formation +
// players) — see roster.js's own comment on why.
router.post('/roster/import', requireAuth, async (req, res) => {
  const { formation, players } = req.body || {};
  if (!soccerLineup.isValidRosterShape({ players })) {
    return res.status(400).json({ ok: false, error: 'That file is not a roster backup this app recognizes.' });
  }
  try {
    const roster = await soccerLineup.withRosterLock(req.session.username, async () => {
      const restored = {
        formation: soccerLineup.DEFAULT_FORMATION,
        players: players.map((p) => ({
          id: crypto.randomUUID(),
          name: p.name,
          skills: { offense: p.skills.offense, defense: p.skills.defense, goalie: p.skills.goalie },
        })),
      };
      if (formation) {
        try {
          soccerLineup.applyFormationSetting(restored, formation);
        } catch {
          // An unrecognized formation in the file is never a reason to
          // reject the whole restore — the roster/players themselves are
          // already valid at this point, so fall back to the default
          // rather than losing a coach's players over one bad field.
        }
      }
      soccerLineup.saveRoster(req.session.username, restored);
      return restored;
    });
    res.json({ ok: true, roster });
  } catch {
    res.status(500).json({ ok: false, error: 'Could not restore that backup — please try again.' });
  }
});

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
