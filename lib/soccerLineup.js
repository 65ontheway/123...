// Domain logic for the "Soccer Lineup" agent: reading a coach's roster and
// deterministically scheduling a full 4-quarter game. Kept out of server.js
// (which stays focused on HTTP routing/auth/proxying) so this stays
// independently readable and testable — see CLAUDE.md's guidance on
// splitting before a file grows past ~500 lines.
//
// The actual scheduling is plain JS, not something the model computes: an
// LLM asked to fill 7 slots x 4 quarters with no repeats, while also
// enforcing AYSO's "everyone plays 3 quarters before anyone plays a 4th"
// fairness rule, will drift on that bookkeeping as the roster grows. The
// model's only job (via the set_game_lineup tool below) is to turn a
// coach's freeform request into structured, per-quarter constraints; this
// file turns those constraints into an actual, fair, valid schedule.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const privateData = require('./privateData');
const { migrateLegacyRosters } = require('./rosterMigration');

const AGENT_ID = 'soccer-lineup';
const AGENT_LABEL = 'Soccer Lineup';
const QUARTERS = [1, 2, 3, 4];

// 7v7 formations, expressed as the position of each of the 7 on-field slots
// (goalkeeper always first). Coaches can pick one per request, or set a
// default in their roster file's own "formation" field.
const FORMATIONS = {
  '2-3-1': ['goalkeeper', 'defender', 'defender', 'midfielder', 'midfielder', 'midfielder', 'forward'],
  '3-2-1': ['goalkeeper', 'defender', 'defender', 'defender', 'midfielder', 'midfielder', 'forward'],
  '2-2-2': ['goalkeeper', 'defender', 'defender', 'midfielder', 'midfielder', 'forward', 'forward'],
  '3-1-2': ['goalkeeper', 'defender', 'defender', 'defender', 'midfielder', 'forward', 'forward'],
};
const DEFAULT_FORMATION = '2-3-1';
const POSITIONS = ['goalkeeper', 'defender', 'midfielder', 'forward'];

// Coaches rate each player 1-5 on three simple categories rather than one
// per formation position — most youth coaches think in "offense / defense /
// goalie", not formal position labels. Midfielder has no direct rating of
// its own since the role plays both ways, so it's scored as the average of
// offense and defense.
function positionSkill(player, position) {
  const skills = player.skills || {};
  if (position === 'goalkeeper') return skills.goalie ?? 0;
  if (position === 'defender') return skills.defense ?? 0;
  if (position === 'forward') return skills.offense ?? 0;
  if (position === 'midfielder') return ((skills.offense ?? 0) + (skills.defense ?? 0)) / 2;
  return 0;
}

// Roster data lives per-account, keyed off the logged-in session's
// username, so one coach's roster is never visible to another account.
// (There's only ever been one hardcoded login so far — this is
// forward-looking isolation, done now so it's already correct whenever
// real multi-account login lands, rather than a migration later.)
//
// The directory itself lives OUTSIDE this git repository (see
// privateData.js) — real kids' names and stats shouldn't sit in a folder
// that could get copied, zipped, or pushed as part of the project. The
// directory is resolved lazily (not at module load) so requiring this
// module never has a filesystem side effect on its own; initRosterStorage()
// is the one place that actually touches disk to set things up, called
// once by server.js at startup.
let rosterDirCache = null;

function getRosterDir() {
  if (!rosterDirCache) {
    rosterDirCache = path.join(privateData.resolvePrivateDataDir(), 'rosters');
  }
  return rosterDirCache;
}

// Ensures the private roster directory exists and migrates any legacy
// data/rosters/*.json into it. Idempotent — safe to call on every startup,
// and in tests. Returns the migration summary (filenames only, never
// roster content) for the caller to log.
function initRosterStorage() {
  const dir = getRosterDir();
  privateData.ensurePrivateDir(dir);
  return migrateLegacyRosters(dir);
}

function safeFileNameFor(username) {
  return String(username).replace(/[^a-zA-Z0-9_-]/g, '_') || 'default';
}

const rosterCache = new Map(); // username -> { roster, mtimeMs }

function rosterFilePath(username) {
  return path.join(getRosterDir(), `${safeFileNameFor(username)}.json`);
}

function isValidRosterShape(parsed) {
  return !!parsed && typeof parsed === 'object' && Array.isArray(parsed.players);
}

// Assigns a stable id to any player that doesn't already have one (e.g. a
// roster migrated from before ids existed). Ids, once assigned, never
// change — they're what the app uses to reference a specific player
// without relying on their name (which can repeat, be edited, or need to
// stay out of an AI request entirely). Returns whether anything changed.
function backfillPlayerIds(roster) {
  let changed = false;
  for (const player of roster.players) {
    if (!player.id) {
      player.id = crypto.randomUUID();
      changed = true;
    }
  }
  return changed;
}

// Reads a roster and reports exactly what happened — 'missing' (no file
// yet, a genuinely new account) is a completely different situation from
// 'invalid' (a corrupt/malformed file) or 'error' (couldn't even read it,
// e.g. a permissions problem), and callers must not treat the latter two
// as if they were the first. Re-reads only when the file's mtime changes,
// same pattern as facts.md — edit the file and the next request picks it
// up, no restart needed.
function loadRosterResult(username) {
  const file = rosterFilePath(username);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    if (err && err.code === 'ENOENT') return { status: 'missing', roster: null };
    return { status: 'error', roster: null, error: (err && err.code) || 'stat-failed' };
  }

  const cached = rosterCache.get(username);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return { status: 'ok', roster: cached.roster };
  }

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { status: 'error', roster: null, error: (err && err.code) || 'read-failed' };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'invalid', roster: null, error: 'invalid-json' };
  }
  if (!isValidRosterShape(parsed)) {
    return { status: 'invalid', roster: null, error: 'missing-players-array' };
  }

  if (backfillPlayerIds(parsed)) {
    // Persist newly-assigned ids immediately so they're actually stable
    // across restarts, not just for the life of this cache entry.
    saveRoster(username, parsed);
    return { status: 'ok', roster: parsed };
  }

  rosterCache.set(username, { roster: parsed, mtimeMs: stat.mtimeMs });
  return { status: 'ok', roster: parsed };
}

// Convenience wrapper for the common case: a roster, or null for a
// genuinely new account. Anything else (corrupt file, permission error)
// throws rather than silently returning null — the old behavior collapsed
// every failure into "no roster," which let an innocent edit silently
// overwrite a roster that was actually just unreadable. Callers that need
// to react differently to each case should call loadRosterResult directly.
function loadRoster(username) {
  const result = loadRosterResult(username);
  if (result.status === 'ok') return result.roster;
  if (result.status === 'missing') return null;
  const err = new Error(`Roster file for this account exists but could not be read (${result.error}).`);
  err.code = 'ROSTER_UNREADABLE';
  err.rosterStatus = result.status;
  throw err;
}

// Writes the roster through a temp file in the same directory, then an
// atomic rename into place (privateData.atomicWriteFileSync) — a reader
// never sees a half-written file, and if the write itself fails partway
// (disk full, permissions), the previous saved roster is left untouched
// rather than replaced with a corrupt one. Refreshes the cache so the very
// next read (e.g. the explanation half of the same request) sees the
// change immediately rather than racing the file's mtime.
function saveRoster(username, roster) {
  const dir = getRosterDir();
  privateData.ensurePrivateDir(dir);
  const file = rosterFilePath(username);
  privateData.atomicWriteFileSync(file, JSON.stringify(roster, null, 2) + '\n', { mode: 0o600 });
  rosterCache.set(username, { roster, mtimeMs: fs.statSync(file).mtimeMs });
}

// Serializes read-modify-write sequences per account so two concurrent
// requests for the same coach (two browser tabs, a chat edit racing a
// panel edit) can't silently clobber each other — without this, the time
// between loading a roster and saving it back (which can span an awaited
// OpenRouter call) is a real window for a lost update. Different accounts
// never wait on each other.
const rosterLocks = new Map(); // username -> tail of that account's queue

function withRosterLock(username, fn) {
  const tail = rosterLocks.get(username) || Promise.resolve();
  const result = tail.then(fn, fn);
  // Keep the queue alive for the next caller even if this one throws, but
  // let the rejection still propagate to whoever's awaiting `result`.
  rosterLocks.set(username, result.catch(() => {}));
  return result;
}

// Multi-line description of the full roster (names *and* ratings) for the
// system prompt — lets the model answer "what's Sarah rated at" or narrate
// *why* a lineup looks the way it does, even though it never computes one.
function describeRoster(roster) {
  if (roster.players.length === 0) return '(no players yet)';
  return roster.players
    .map((p) => {
      const s = p.skills || {};
      return `- ${p.name}: offense ${s.offense ?? '?'}, defense ${s.defense ?? '?'}, goalie ${s.goalie ?? '?'}`;
    })
    .join('\n');
}

// The tool definition sent to OpenRouter. The model's job is limited to
// filling this in from the coach's message — it never sees or computes the
// actual player assignments. Constraints are keyed by quarter number
// ("1"-"4") since AYSO allows a free substitution between each quarter.
const SET_GAME_LINEUP_TOOL = {
  type: 'function',
  function: {
    name: 'set_game_lineup',
    description:
      'Record the constraints for a full 4-quarter 7v7 soccer game from the coach\'s request. ' +
      'Does not compute the lineup itself — the app schedules the actual game from these constraints, ' +
      'including AYSO\'s rule that every player plays 3 quarters before anyone plays a 4th.',
    parameters: {
      type: 'object',
      properties: {
        formation: {
          type: 'string',
          enum: Object.keys(FORMATIONS),
          description: `Formation to use for the whole game. Omit to use the roster's own default (${DEFAULT_FORMATION} if it doesn't set one).`,
        },
        resting: {
          type: 'object',
          description:
            'Map of quarter number ("1"-"4") to the names of players sitting out that quarter. ' +
            '"first half" means quarters 1 and 2; "second half" means quarters 3 and 4.',
          additionalProperties: { type: 'array', items: { type: 'string' } },
        },
        pinned: {
          type: 'object',
          description:
            'Map of quarter number ("1"-"4") to a map of {"Player Name": "position"} for players the ' +
            'coach explicitly assigned that quarter. Position must be one of: goalkeeper, defender, midfielder, forward.',
          additionalProperties: {
            type: 'object',
            additionalProperties: { type: 'string', enum: POSITIONS },
          },
        },
      },
      required: [],
    },
  },
};

// Lets a coach update ratings or remove a player through chat — "bump
// Emma's defense to a 4", "remove Jenny, she moved teams" — instead of
// hand-editing the JSON file. Deliberately has NO "add" capability: adding
// a brand-new player means telling the model a real name that doesn't
// exist anywhere yet, which the app has no way to intercept or anonymize
// beforehand (there's no existing player record to map it to). Introducing
// a new player is only ever done through the roster panel's direct form,
// which never involves an AI call at all — see soccerPrivacy.js and the
// roster panel endpoints in server.js. Like set_game_lineup, the model only
// extracts *what* the coach wants changed; the actual read-modify-write of
// the roster file happens in applyRosterEdits()/saveRoster(), never as
// model-generated file content — a single slip in a freehanded rewrite
// could otherwise corrupt or drop other players' data.
const RATING_SCHEMA = { type: 'integer', minimum: 1, maximum: 5 };
const MANAGE_ROSTER_TOOL = {
  type: 'function',
  function: {
    name: 'manage_roster',
    description:
      'Update ratings or remove one or more EXISTING players on the coach\'s roster, all in a single call. ' +
      'Cannot add a new player — if the coach wants to add someone, tell them to use the roster panel instead. ' +
      'Does not edit the roster file itself — the app applies these changes.',
    parameters: {
      type: 'object',
      properties: {
        update: {
          type: 'array',
          description: 'Existing players whose ratings should change. Only the fields given are changed.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              offense: RATING_SCHEMA,
              defense: RATING_SCHEMA,
              goalie: RATING_SCHEMA,
            },
            required: ['name'],
          },
        },
        remove: {
          type: 'array',
          description: 'Names of players to remove from the roster entirely.',
          items: { type: 'string' },
        },
      },
      required: [],
    },
  },
};

function findPlayer(players, name) {
  const needle = name.trim().toLowerCase();
  return players.find((p) => p.name.trim().toLowerCase() === needle) || null;
}

function findPlayerById(players, id) {
  return players.find((p) => p.id === id) || null;
}

const DEFAULT_SKILL_RATING = 3;
const MAX_NAME_LENGTH = 100;

function clampRating(value) {
  return Math.min(5, Math.max(1, Math.round(value)));
}

class RosterValidationError extends Error {}

function validateNewPlayerName(name) {
  if (typeof name !== 'string' || !name.trim()) {
    throw new RosterValidationError('A player name is required.');
  }
  if (name.trim().length > MAX_NAME_LENGTH) {
    throw new RosterValidationError(`Player name must be ${MAX_NAME_LENGTH} characters or fewer.`);
  }
}

// --- Direct, ID-based CRUD for the roster panel (public/js/roster.js via
// server.js's /api/soccer/roster endpoints). No LLM is involved in any of
// these — a real name only ever needs to pass through this path, never a
// model request, which is exactly why the roster panel exists as a
// separate, chat-free way to manage players. Referencing players by id
// (rather than by name, like the chat-driven applyRosterEdits below) means
// two players who happen to share a name are never ambiguous here.
function addPlayerDirect(roster, { name, offense, defense, goalie } = {}) {
  validateNewPlayerName(name);
  const player = {
    id: crypto.randomUUID(),
    name: name.trim(),
    skills: {
      offense: clampRating(offense ?? DEFAULT_SKILL_RATING),
      defense: clampRating(defense ?? DEFAULT_SKILL_RATING),
      goalie: clampRating(goalie ?? DEFAULT_SKILL_RATING),
    },
  };
  roster.players.push(player);
  return player;
}

function updatePlayerDirect(roster, id, { name, offense, defense, goalie } = {}) {
  const player = findPlayerById(roster.players, id);
  if (!player) return null;
  if (name != null) {
    validateNewPlayerName(name);
    player.name = name.trim();
  }
  for (const [key, value] of [
    ['offense', offense],
    ['defense', defense],
    ['goalie', goalie],
  ]) {
    if (value != null) player.skills[key] = clampRating(value);
  }
  return player;
}

function removePlayerDirect(roster, id) {
  const idx = roster.players.findIndex((p) => p.id === id);
  if (idx === -1) return null;
  const [removed] = roster.players.splice(idx, 1);
  return removed;
}

function applyRatingFields(player, entry, changeLog) {
  const changed = [];
  for (const key of ['offense', 'defense', 'goalie']) {
    if (entry[key] != null) {
      player.skills[key] = clampRating(entry[key]);
      changed.push(`${key} ${player.skills[key]}`);
    }
  }
  if (changed.length > 0) changeLog.push(`Updated ${player.name}: ${changed.join(', ')}.`);
  return changed.length > 0;
}

// Pure-ish function (mutates the passed-in roster in place, same object
// loadRoster/saveRoster share) applying a batch of add/update/remove edits.
// Never throws on bad input (unknown names, an add for someone who already
// exists) — it does the sensible thing and reports what happened in
// `messages`, for the same reason computeGameLineup reports `warnings`
// instead of failing: this feeds an LLM's explanation back to a coach.
function applyRosterEdits(roster, edits = {}) {
  const { add = [], update = [], remove = [] } = edits;
  const messages = [];

  for (const entry of add) {
    const existing = findPlayer(roster.players, entry.name);
    if (existing) {
      if (!applyRatingFields(existing, entry, messages)) {
        messages.push(`${existing.name} is already on the roster — no rating changes given.`);
      }
      continue;
    }
    const player = {
      id: crypto.randomUUID(),
      name: entry.name.trim(),
      skills: {
        offense: clampRating(entry.offense ?? DEFAULT_SKILL_RATING),
        defense: clampRating(entry.defense ?? DEFAULT_SKILL_RATING),
        goalie: clampRating(entry.goalie ?? DEFAULT_SKILL_RATING),
      },
    };
    roster.players.push(player);
    messages.push(
      `Added ${player.name} (offense ${player.skills.offense}, defense ${player.skills.defense}, goalie ${player.skills.goalie}).`
    );
  }

  for (const entry of update) {
    const player = findPlayer(roster.players, entry.name);
    if (!player) {
      messages.push(`Could not update "${entry.name}" — no player with that name was found.`);
      continue;
    }
    if (!applyRatingFields(player, entry, messages)) {
      messages.push(`No rating changes given for ${player.name}.`);
    }
  }

  for (const name of remove) {
    const idx = roster.players.findIndex((p) => p.name.trim().toLowerCase() === name.trim().toLowerCase());
    if (idx === -1) {
      messages.push(`Could not remove "${name}" — no player with that name was found.`);
      continue;
    }
    const [removed] = roster.players.splice(idx, 1);
    messages.push(`Removed ${removed.name}.`);
  }

  return messages;
}

function formatRosterEditResult(messages) {
  return messages.length > 0 ? messages.join('\n') : 'No changes were requested.';
}

// Would giving `player` their next quarter hand them a 4th quarter before
// every other still-available player (in this quarter) has reached 3? That's
// the one thing AYSO's fairness rule actually forbids.
function wouldViolateFairness(player, quartersPlayed, othersAvailableThisQuarter) {
  if (quartersPlayed.get(player) + 1 !== 4) return false;
  return othersAvailableThisQuarter.some((o) => o !== player && quartersPlayed.get(o) < 3);
}

// Pure function: given a roster and a set of per-quarter constraints,
// returns a full 4-quarter schedule. `resting`/`pinned` reference players
// by id, not name — resolving them is the caller's job (soccerLineupChat.js
// translates the model's opaque player labels to ids before calling this),
// which keeps this function correct even when two players share a name:
// an id always means one specific player, where a name might not. Never
// throws on bad input (an id that doesn't resolve, impossible pins, too
// few players) — it does the best it can and reports problems as
// `warnings`, since this is feeding an LLM's explanation back to a coach,
// not a strict API contract.
function computeGameLineup(roster, constraints = {}) {
  const { formation: requestedFormation, resting = {}, pinned = {} } = constraints;
  const warnings = [];

  const formationName =
    requestedFormation && FORMATIONS[requestedFormation]
      ? requestedFormation
      : roster.formation && FORMATIONS[roster.formation]
        ? roster.formation
        : DEFAULT_FORMATION;
  const slots = FORMATIONS[formationName];

  const quartersPlayed = new Map(roster.players.map((p) => [p, 0]));
  const quarters = [];

  for (const q of QUARTERS) {
    const qKey = String(q);
    const restingIds = resting[qKey] || [];
    const restingPlayers = [];
    for (const id of restingIds) {
      const player = findPlayerById(roster.players, id);
      if (player) restingPlayers.push(player);
      else warnings.push(`Q${q}: a player marked resting isn't on the roster — ignored.`);
    }
    const available = roster.players.filter((p) => !restingPlayers.includes(p));

    const lineup = slots.map((position) => ({ position, player: null }));
    const usedThisQuarter = new Set();

    const pinnedThisQuarter = pinned[qKey] || {};
    for (const [id, position] of Object.entries(pinnedThisQuarter)) {
      const player = findPlayerById(available, id);
      if (!player) {
        warnings.push(`Q${q}: a player pinned to ${position} isn't available — ignored.`);
        continue;
      }
      if (usedThisQuarter.has(player)) {
        warnings.push(`Q${q}: ${player.name} was pinned more than once — used the first assignment.`);
        continue;
      }
      const openSlot = lineup.find((s) => s.position === position && !s.player);
      if (!openSlot) {
        warnings.push(`Q${q}: no open ${position} slot left for ${player.name} in the ${formationName} formation — left unassigned.`);
        continue;
      }
      if (wouldViolateFairness(player, quartersPlayed, available.filter((o) => !usedThisQuarter.has(o)))) {
        warnings.push(
          `Q${q}: pinning ${player.name} gives them a 4th quarter before everyone else has played 3 (AYSO fairness rule) — honored anyway since you explicitly requested it.`
        );
      }
      openSlot.player = player;
      usedThisQuarter.add(player);
    }

    for (const slot of lineup) {
      if (slot.player) continue;
      const remaining = available.filter((p) => !usedThisQuarter.has(p));
      if (remaining.length === 0) {
        warnings.push(`Q${q}: not enough available players to fill every ${formationName} slot.`);
        continue;
      }
      // Fairness first (fewest quarters played so far), skill as tiebreaker.
      // A candidate who'd take a 4th quarter before others reach 3 is
      // skipped in favor of anyone else, unless literally no one else
      // qualifies — that's reported as a warning rather than forced silently.
      const sorted = [...remaining].sort((a, b) => {
        const qA = quartersPlayed.get(a);
        const qB = quartersPlayed.get(b);
        if (qA !== qB) return qA - qB;
        return positionSkill(b, slot.position) - positionSkill(a, slot.position);
      });
      let chosen = sorted.find((p) => !wouldViolateFairness(p, quartersPlayed, remaining));
      if (!chosen) {
        chosen = sorted[0];
        warnings.push(`Q${q}: ${chosen.name} plays a 4th quarter before everyone else has played 3 — unavoidable given the remaining constraints.`);
      }
      slot.player = chosen;
      usedThisQuarter.add(chosen);
    }

    for (const p of usedThisQuarter) quartersPlayed.set(p, quartersPlayed.get(p) + 1);
    const bench = available.filter((p) => !usedThisQuarter.has(p));
    quarters.push({ quarter: q, lineup, bench });
  }

  const quartersPlayedSummary = roster.players.map((p) => ({
    id: p.id,
    name: p.name,
    quartersPlayed: quartersPlayed.get(p),
  }));

  return { formation: formationName, quarters, quartersPlayedSummary, warnings };
}

// Renders the computed schedule as plain text for the tool result — this is
// what the model sees and explains back to the coach, so it's written to
// be readable as-is even before the model touches it. Per-quarter listing
// only (no grid/table needed).
function formatGameLineupResult({ formation, quarters, quartersPlayedSummary, warnings }) {
  const lines = [`Formation: ${formation}`];
  for (const { quarter, lineup, bench } of quarters) {
    lines.push('', `Quarter ${quarter}:`);
    for (const slot of lineup) {
      const label = slot.position[0].toUpperCase() + slot.position.slice(1);
      lines.push(`${label}: ${slot.player ? slot.player.name : '(unfilled)'}`);
    }
    if (bench.length > 0) lines.push(`Bench: ${bench.map((p) => p.name).join(', ')}`);
  }
  lines.push('', 'Quarters played this game:');
  for (const { name, quartersPlayed } of quartersPlayedSummary) {
    lines.push(`${name}: ${quartersPlayed}`);
  }
  if (warnings.length > 0) {
    lines.push('', 'Warnings:', ...warnings.map((w) => `- ${w}`));
  }
  return lines.join('\n');
}

module.exports = {
  AGENT_ID,
  AGENT_LABEL,
  FORMATIONS,
  DEFAULT_FORMATION,
  SET_GAME_LINEUP_TOOL,
  MANAGE_ROSTER_TOOL,
  getRosterDir,
  initRosterStorage,
  loadRoster,
  loadRosterResult,
  saveRoster,
  describeRoster,
  computeGameLineup,
  formatGameLineupResult,
  applyRosterEdits,
  formatRosterEditResult,
  findPlayer,
  findPlayerById,
  addPlayerDirect,
  updatePlayerDirect,
  removePlayerDirect,
  withRosterLock,
  RosterValidationError,
};
