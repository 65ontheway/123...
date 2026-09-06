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

// Roster data lives per-account at data/rosters/<username>.json, keyed off
// the logged-in session's username, so one coach's roster is never visible
// to another account. (There's only ever been one hardcoded login so far —
// this is forward-looking isolation, done now so it's already correct
// whenever real multi-account login lands, rather than a migration later.)
const ROSTER_DIR = path.join(__dirname, '..', process.env.ROSTER_DIR || 'data/rosters');

function safeFileNameFor(username) {
  return String(username).replace(/[^a-zA-Z0-9_-]/g, '_') || 'default';
}

const rosterCache = new Map(); // username -> { roster, mtimeMs }

function rosterFilePath(username) {
  return path.join(ROSTER_DIR, `${safeFileNameFor(username)}.json`);
}

// Re-read whenever the file's mtime changes, same pattern as facts.md —
// edit the roster and the next request picks it up, no restart needed.
function loadRoster(username) {
  const file = rosterFilePath(username);
  try {
    const mtimeMs = fs.statSync(file).mtimeMs;
    const cached = rosterCache.get(username);
    if (!cached || cached.mtimeMs !== mtimeMs) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(parsed.players)) throw new Error('roster file must have a "players" array');
      rosterCache.set(username, { roster: parsed, mtimeMs });
    }
    return rosterCache.get(username).roster;
  } catch {
    return null;
  }
}

// Writes the roster back to disk and refreshes the cache so the very next
// read (e.g. the explanation half of the same request) sees the change
// immediately rather than racing the file's mtime.
function saveRoster(username, roster) {
  const file = rosterFilePath(username);
  fs.mkdirSync(ROSTER_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(roster, null, 2) + '\n', 'utf8');
  rosterCache.set(username, { roster, mtimeMs: fs.statSync(file).mtimeMs });
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

// Lets a coach build and maintain the roster entirely through chat — "add
// Sarah, she's a 4 offense 2 defense 1 goalie", "bump Emma's defense to a
// 4", "remove Jenny, she moved teams" — instead of hand-editing the JSON
// file. Takes arrays so one message ("add these five girls: ...") can add a
// whole team in a single call. Like set_game_lineup, the model only
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
      'Add, update, or remove one or more players on the coach\'s roster, all in a single call. ' +
      'Does not edit the roster file itself — the app applies these changes.',
    parameters: {
      type: 'object',
      properties: {
        add: {
          type: 'array',
          description:
            'New players to add. Ratings are optional (default to a neutral 3 if not given). ' +
            'If a name already exists, this updates their ratings instead of creating a duplicate.',
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

const DEFAULT_SKILL_RATING = 3;

function clampRating(value) {
  return Math.min(5, Math.max(1, Math.round(value)));
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
// returns a full 4-quarter schedule. Never throws on bad input (unknown
// names, impossible pins, too few players) — it does the best it can and
// reports problems as `warnings`, since this is feeding an LLM's
// explanation back to a coach, not a strict API contract.
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
    const restingNames = resting[qKey] || [];
    const restingPlayers = [];
    for (const name of restingNames) {
      const player = findPlayer(roster.players, name);
      if (player) restingPlayers.push(player);
      else warnings.push(`Q${q}: "${name}" (marked resting) isn't on the roster — ignored.`);
    }
    const available = roster.players.filter((p) => !restingPlayers.includes(p));

    const lineup = slots.map((position) => ({ position, player: null }));
    const usedThisQuarter = new Set();

    const pinnedThisQuarter = pinned[qKey] || {};
    for (const [name, position] of Object.entries(pinnedThisQuarter)) {
      const player = findPlayer(available, name);
      if (!player) {
        warnings.push(`Q${q}: "${name}" (pinned to ${position}) isn't available — ignored.`);
        continue;
      }
      if (usedThisQuarter.has(player)) {
        warnings.push(`Q${q}: "${name}" was pinned more than once — used the first assignment.`);
        continue;
      }
      const openSlot = lineup.find((s) => s.position === position && !s.player);
      if (!openSlot) {
        warnings.push(`Q${q}: no open ${position} slot left for "${name}" in the ${formationName} formation — left unassigned.`);
        continue;
      }
      if (wouldViolateFairness(player, quartersPlayed, available.filter((o) => !usedThisQuarter.has(o)))) {
        warnings.push(
          `Q${q}: pinning ${name} gives them a 4th quarter before everyone else has played 3 (AYSO fairness rule) — honored anyway since you explicitly requested it.`
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

  const quartersPlayedSummary = roster.players.map((p) => ({ name: p.name, quartersPlayed: quartersPlayed.get(p) }));

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
  ROSTER_DIR,
  loadRoster,
  saveRoster,
  describeRoster,
  computeGameLineup,
  formatGameLineupResult,
  applyRosterEdits,
  formatRosterEditResult,
};
