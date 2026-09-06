// Domain logic for the "Soccer Lineup" agent: reading the roster file and
// deterministically assigning players to formation slots. Kept out of
// server.js (which stays focused on HTTP routing/auth/proxying) so this
// stays independently readable and testable — see CLAUDE.md's guidance on
// splitting before a file grows past ~500 lines.
//
// The actual lineup assignment is plain JS, not something the model
// computes: an LLM asked to "assign 7 players to 7 slots with no repeats"
// will occasionally double-book a position or drop a player. The model's
// only job (via the set_lineup tool below) is to turn a coach's freeform
// request into structured constraints; this file turns those constraints
// into an actual, valid lineup.

const fs = require('fs');
const path = require('path');

const AGENT_ID = 'soccer-lineup';
const AGENT_LABEL = 'Soccer Lineup';

// 7v7 formations, expressed as the position of each of the 7 on-field slots
// (goalkeeper always first). Coaches can pick one per request, or set a
// default in roster.json's own "formation" field.
const FORMATIONS = {
  '2-3-1': ['goalkeeper', 'defender', 'defender', 'midfielder', 'midfielder', 'midfielder', 'forward'],
  '3-2-1': ['goalkeeper', 'defender', 'defender', 'defender', 'midfielder', 'midfielder', 'forward'],
  '2-2-2': ['goalkeeper', 'defender', 'defender', 'midfielder', 'midfielder', 'forward', 'forward'],
  '3-1-2': ['goalkeeper', 'defender', 'defender', 'defender', 'midfielder', 'forward', 'forward'],
};
const DEFAULT_FORMATION = '2-3-1';
const POSITIONS = ['goalkeeper', 'defender', 'midfielder', 'forward'];

const ROSTER_FILE = path.join(__dirname, '..', process.env.ROSTER_FILE || 'roster.json');
let rosterCache = { roster: null, mtimeMs: 0 };

// Re-read whenever the file's mtime changes, same pattern as facts.md —
// edit the roster and the next request picks it up, no restart needed.
function loadRoster() {
  try {
    const mtimeMs = fs.statSync(ROSTER_FILE).mtimeMs;
    if (mtimeMs !== rosterCache.mtimeMs) {
      const parsed = JSON.parse(fs.readFileSync(ROSTER_FILE, 'utf8'));
      if (!Array.isArray(parsed.players)) throw new Error('roster.json must have a "players" array');
      rosterCache = { roster: parsed, mtimeMs };
    }
    return rosterCache.roster;
  } catch {
    return null;
  }
}

// The tool definition sent to OpenRouter. The model's job is limited to
// filling this in from the coach's message — it never sees or computes the
// actual player assignments.
const SET_LINEUP_TOOL = {
  type: 'function',
  function: {
    name: 'set_lineup',
    description:
      'Record the constraints for a 7v7 soccer lineup from the coach\'s request. ' +
      'Does not compute the lineup itself — the app does that from these constraints.',
    parameters: {
      type: 'object',
      properties: {
        formation: {
          type: 'string',
          enum: Object.keys(FORMATIONS),
          description: `Formation to use. Omit to use the roster's own default (${DEFAULT_FORMATION} if it doesn't set one).`,
        },
        resting: {
          type: 'array',
          items: { type: 'string' },
          description: 'Names of players who should sit out this lineup.',
        },
        pinned: {
          type: 'object',
          additionalProperties: { type: 'string', enum: POSITIONS },
          description:
            'Players the coach explicitly assigned to a position, as {"Player Name": "position"}. ' +
            'Position must be one of: goalkeeper, defender, midfielder, forward.',
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

// Pure function: given a roster and a set of constraints, returns a valid
// lineup. Never throws on bad input (unknown names, impossible pins, too
// few players) — it does the best it can and reports problems as
// `warnings`, since this is feeding an LLM's explanation back to a coach,
// not a strict API contract.
function computeLineup(roster, constraints = {}) {
  const { formation: requestedFormation, resting = [], pinned = {} } = constraints;
  const warnings = [];

  const formationName =
    requestedFormation && FORMATIONS[requestedFormation]
      ? requestedFormation
      : roster.formation && FORMATIONS[roster.formation]
        ? roster.formation
        : DEFAULT_FORMATION;
  const slots = FORMATIONS[formationName];

  const restingPlayers = [];
  for (const name of resting) {
    const player = findPlayer(roster.players, name);
    if (player) restingPlayers.push(player);
    else warnings.push(`"${name}" (marked resting) isn't on the roster — ignored.`);
  }
  const available = roster.players.filter((p) => !restingPlayers.includes(p));

  const lineup = slots.map((position) => ({ position, player: null }));
  const used = new Set();

  for (const [name, position] of Object.entries(pinned)) {
    const player = findPlayer(available, name);
    if (!player) {
      warnings.push(`"${name}" (pinned to ${position}) isn't available — ignored.`);
      continue;
    }
    if (used.has(player)) {
      warnings.push(`"${name}" was pinned more than once — used the first assignment.`);
      continue;
    }
    const openSlot = lineup.find((s) => s.position === position && !s.player);
    if (!openSlot) {
      warnings.push(`No open ${position} slot left for "${name}" in the ${formationName} formation — left unassigned.`);
      continue;
    }
    openSlot.player = player;
    used.add(player);
  }

  for (const slot of lineup) {
    if (slot.player) continue;
    const candidates = available
      .filter((p) => !used.has(p))
      .sort((a, b) => (b.skills?.[slot.position] ?? 0) - (a.skills?.[slot.position] ?? 0));
    if (candidates.length === 0) {
      warnings.push(`Not enough available players to fill every ${formationName} slot.`);
      break;
    }
    slot.player = candidates[0];
    used.add(candidates[0]);
  }

  const bench = available.filter((p) => !used.has(p));

  return { formation: formationName, lineup, bench, warnings };
}

// Renders the computed lineup as plain text for the tool result — this is
// what the model sees and explains back to the coach, so it's written to
// be readable as-is even before the model touches it.
function formatLineupResult({ formation, lineup, bench, warnings }) {
  const lines = [`Formation: ${formation}`, ''];
  for (const slot of lineup) {
    const label = slot.position[0].toUpperCase() + slot.position.slice(1);
    lines.push(`${label}: ${slot.player ? slot.player.name : '(unfilled)'}`);
  }
  if (bench.length > 0) {
    lines.push('', `Bench: ${bench.map((p) => p.name).join(', ')}`);
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
  SET_LINEUP_TOOL,
  loadRoster,
  computeLineup,
  formatLineupResult,
};
