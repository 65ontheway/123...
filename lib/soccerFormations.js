// The formation/position catalog for the Soccer Lineup agent: every 7v7
// slot in every supported formation, with a stable id, a readable label,
// the broad role it counts as for skill scoring, and which side (if any)
// it belongs to. Split out of soccerLineup.js per CLAUDE.md's file-size
// guidance, and because this catalog is a natural, self-contained unit —
// the scheduler, the privacy layer, and the roster panel's settings UI all
// need to agree on the same ids and labels.
//
// A player is scheduled into a ROLE (goalkeeper/defender/midfielder/
// forward) first — that's what skill ratings are scored against, unchanged
// from before this file existed — and only assigned to one of that role's
// exact slots afterward, when there's a choice (see soccerSidePreferences.js
// for that side-assignment step). Some roles have only one slot in a given
// formation (e.g. the lone striker in 2-3-1), so "assigned to a role" and
// "assigned to an exact position" end up meaning the same thing there.

class RosterValidationError extends Error {}

const ROLES = ['goalkeeper', 'defender', 'midfielder', 'forward'];

// id -> { id, label, role, side }. `side` is 'left' | 'right' | 'center' |
// null (goalkeeper and a lone striker have no side at all).
const POSITION_CATALOG = {
  goalkeeper: { id: 'goalkeeper', label: 'Goalkeeper', role: 'goalkeeper', side: null },
  left_back: { id: 'left_back', label: 'Left Back', role: 'defender', side: 'left' },
  center_back: { id: 'center_back', label: 'Center Back', role: 'defender', side: 'center' },
  right_back: { id: 'right_back', label: 'Right Back', role: 'defender', side: 'right' },
  left_wing: { id: 'left_wing', label: 'Left Wing', role: 'midfielder', side: 'left' },
  center_mid: { id: 'center_mid', label: 'Center Mid', role: 'midfielder', side: 'center' },
  right_wing: { id: 'right_wing', label: 'Right Wing', role: 'midfielder', side: 'right' },
  left_midfield: { id: 'left_midfield', label: 'Left Midfield', role: 'midfielder', side: 'left' },
  right_midfield: { id: 'right_midfield', label: 'Right Midfield', role: 'midfielder', side: 'right' },
  striker: { id: 'striker', label: 'Striker', role: 'forward', side: null },
  left_forward: { id: 'left_forward', label: 'Left Forward', role: 'forward', side: 'left' },
  right_forward: { id: 'right_forward', label: 'Right Forward', role: 'forward', side: 'right' },
};

// Each formation is its 7 slots, goalkeeper first, in on-field order —
// this order is also what formatters use to print a lineup, and what the
// scheduler's fairness/skill fill walks through when there's no pin.
const FORMATIONS = {
  '2-3-1': ['goalkeeper', 'left_back', 'right_back', 'left_wing', 'center_mid', 'right_wing', 'striker'],
  '3-2-1': ['goalkeeper', 'left_back', 'center_back', 'right_back', 'left_midfield', 'right_midfield', 'striker'],
  '2-2-2': ['goalkeeper', 'left_back', 'right_back', 'left_midfield', 'right_midfield', 'left_forward', 'right_forward'],
  '3-1-2': ['goalkeeper', 'left_back', 'center_back', 'right_back', 'center_mid', 'left_forward', 'right_forward'],
};
const DEFAULT_FORMATION = '2-3-1';

// Coaches rate each player 1-5 on three simple categories rather than one
// per formation position — most youth coaches think in "offense / defense /
// goalie", not formal position labels. Midfielder (including a wing, which
// is a midfielder role with a side) has no direct rating of its own since
// the role plays both ways, so it's scored as the average of offense and
// defense. Unchanged from before this file existed.
function positionSkill(player, role) {
  const skills = player.skills || {};
  if (role === 'goalkeeper') return skills.goalie ?? 0;
  if (role === 'defender') return skills.defense ?? 0;
  if (role === 'forward') return skills.offense ?? 0;
  if (role === 'midfielder') return ((skills.offense ?? 0) + (skills.defense ?? 0)) / 2;
  return 0;
}

function formatPositionLabel(positionId) {
  return POSITION_CATALOG[positionId]?.label || positionId;
}

// A formation named by the request, falling back to the roster's own
// default, falling back to DEFAULT_FORMATION — same resolution used
// everywhere a formation needs picking (scheduling, validating a pin,
// resolving saved side preferences).
function resolveFormationName(requested, rosterDefault) {
  if (requested && FORMATIONS[requested]) return requested;
  if (rosterDefault && FORMATIONS[rosterDefault]) return rosterDefault;
  return DEFAULT_FORMATION;
}

// Common shorthand/alternate spellings a coach (or the model paraphrasing
// them) might use. Keys are lowercased, trimmed, with runs of whitespace
// collapsed to a single space before lookup — see normalizePositionToken.
const POSITION_ALIASES = {
  goalie: 'goalkeeper',
  keeper: 'goalkeeper',
  gk: 'goalkeeper',
  lb: 'left_back',
  'left back': 'left_back',
  cb: 'center_back',
  'center back': 'center_back',
  'centre back': 'center_back',
  rb: 'right_back',
  'right back': 'right_back',
  lw: 'left_wing',
  'left wing': 'left_wing',
  cm: 'center_mid',
  'center mid': 'center_mid',
  'centre mid': 'center_mid',
  'center midfield': 'center_mid',
  'centre midfield': 'center_mid',
  rw: 'right_wing',
  'right wing': 'right_wing',
  lm: 'left_midfield',
  'left midfield': 'left_midfield',
  rm: 'right_midfield',
  'right midfield': 'right_midfield',
  st: 'striker',
  lf: 'left_forward',
  'left forward': 'left_forward',
  rf: 'right_forward',
  'right forward': 'right_forward',
};

const ROLE_ALIASES = {
  defense: 'defender',
  defence: 'defender',
  defenders: 'defender',
  offense: 'forward',
  offence: 'forward',
  forwards: 'forward',
  striker: 'forward', // only an alias at the ROLE level; the exact id "striker" is handled separately
  mid: 'midfielder',
  midfield: 'midfielder',
  midfielders: 'midfielder',
  wing: 'midfielder',
  goalkeepers: 'goalkeeper',
};

function normalizeToken(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ');
}

// Turns whatever position/role token the model sent (via a tool call, ultimately
// from the coach's own words) into either an exact position id or a role,
// or null if it isn't recognized at all. Deliberately permissive about
// spelling/spacing (see the alias tables above) but never guesses beyond
// them — an unrecognized token is the caller's job to warn about and
// ignore, never to silently substitute something else for.
function normalizePositionToken(raw) {
  const token = normalizeToken(raw);
  if (!token) return null;
  const collapsed = token.replace(/ /g, '_');

  if (ROLES.includes(collapsed)) return { kind: 'role', role: collapsed };
  if (ROLE_ALIASES[token]) return { kind: 'role', role: ROLE_ALIASES[token] };

  if (POSITION_CATALOG[collapsed]) return { kind: 'exact', id: collapsed };
  if (POSITION_ALIASES[token]) return { kind: 'exact', id: POSITION_ALIASES[token] };

  return null;
}

function isExactPositionValidForFormation(formationName, positionId) {
  return (FORMATIONS[formationName] || []).includes(positionId);
}

// Persists the roster's own default formation (the roster panel's
// formation dropdown, not a chat request — set_game_lineup's own
// `formation` argument stays a this-lineup-only override and never
// touches this saved value). Validated against the same catalog every
// other formation lookup in this file uses.
function applyFormationSetting(roster, formation) {
  if (!FORMATIONS[formation]) {
    throw new RosterValidationError(`"${formation}" isn't a supported formation.`);
  }
  roster.formation = formation;
  return formation;
}

// Groups a formation's slots by role into left/right/center for the
// side-assignment step (soccerSidePreferences.js). A role with no side at
// all in this formation (goalkeeper always; forward in 2-3-1/3-2-1, which
// is a single striker) simply has left/right both null and is skipped
// there — nothing to compare.
function getSidePairGroups(formationName) {
  const bySide = { left: {}, right: {}, center: {} };
  for (const positionId of FORMATIONS[formationName] || []) {
    const def = POSITION_CATALOG[positionId];
    if (def.side === 'left') bySide.left[def.role] = positionId;
    else if (def.side === 'right') bySide.right[def.role] = positionId;
    else if (def.side === 'center') bySide.center[def.role] = positionId;
  }
  const roles = new Set([...Object.keys(bySide.left), ...Object.keys(bySide.right), ...Object.keys(bySide.center)]);
  return [...roles].map((role) => ({
    role,
    left: bySide.left[role] || null,
    right: bySide.right[role] || null,
    center: bySide.center[role] || null,
  }));
}

module.exports = {
  RosterValidationError,
  ROLES,
  POSITION_CATALOG,
  FORMATIONS,
  DEFAULT_FORMATION,
  positionSkill,
  formatPositionLabel,
  resolveFormationName,
  normalizePositionToken,
  isExactPositionValidForFormation,
  applyFormationSetting,
  getSidePairGroups,
};
