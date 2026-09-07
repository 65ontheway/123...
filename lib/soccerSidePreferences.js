// Per-role side preferences ("put the lower-average defender on the right")
// for the Soccer Lineup agent: defaults, validation, migrating an older
// roster that predates this setting, resolving what actually applies to
// one lineup (a saved default vs. a this-lineup-only override), and the
// deterministic step that applies the result without changing who plays.
//
// "Lower-average" always means (offense + defense) / 2 — goalie rating
// never factors in, since side preference only ever concerns outfield
// roles that come in a left/right pair (defender, midfielder/wing,
// forward). A role with no preference is stored as `null`, never a
// string, so a truthy check is enough anywhere in this file or its
// callers; 'none' only ever appears at the edges (tool arguments, the
// roster panel's API), where it's normalized to null immediately.
const { RosterValidationError, getSidePairGroups } = require('./soccerFormations');

const SIDE_ROLE_KEYS = ['defender', 'midfielder', 'forward'];

// Defaults chosen for this feature: lower-average defender goes right,
// lower-average midfielder/wing goes left, forwards have no preference
// either way.
const DEFAULT_SIDE_PREFERENCES = { defender: 'right', midfielder: 'left', forward: null };

function isValidSideValue(value) {
  return value === 'left' || value === 'right' || value == null;
}

// Ensures roster.sidePreferences exists and has all three keys, without
// touching any key that's already validly set — an older roster (or one
// only partially migrated by a previous version) gets exactly the missing
// pieces filled in, never a wholesale overwrite. A key holding something
// invalid (hand-edited file, future format change) is treated the same as
// missing: replaced with the default rather than left to crash the
// scheduler later. Returns whether anything actually changed, so the
// caller only re-saves the roster file when needed — same pattern as
// soccerLineup.js's backfillPlayerIds.
function backfillSidePreferences(roster) {
  let changed = false;
  if (!roster.sidePreferences || typeof roster.sidePreferences !== 'object') {
    roster.sidePreferences = { ...DEFAULT_SIDE_PREFERENCES };
    return true;
  }
  for (const role of SIDE_ROLE_KEYS) {
    const value = roster.sidePreferences[role];
    if (value === undefined || !isValidSideValue(value)) {
      roster.sidePreferences[role] = value === undefined ? DEFAULT_SIDE_PREFERENCES[role] : DEFAULT_SIDE_PREFERENCES[role];
      changed = true;
    }
  }
  // Drop any unexpected extra keys from a corrupted/future file rather
  // than carrying them forward silently.
  for (const key of Object.keys(roster.sidePreferences)) {
    if (!SIDE_ROLE_KEYS.includes(key)) {
      delete roster.sidePreferences[key];
      changed = true;
    }
  }
  return changed;
}

// 'none' (the wire-format value used in tool arguments and the roster
// panel's API) becomes null (this module's internal "no preference").
// Anything else must be exactly 'left' or 'right'.
function normalizeIncomingSideValue(role, raw) {
  if (raw === 'none') return null;
  if (raw === 'left' || raw === 'right') return raw;
  throw new RosterValidationError(`Invalid side preference for ${role}: must be "left", "right", or "none".`);
}

// Persists a partial update to the roster's saved defaults — only the
// roles actually present in `updates` change; everything else is left
// exactly as it was, per the requirement that saving one preference never
// touches the others. Never called from the scheduling path itself (that
// only ever reads saved preferences); this is the settings-save path only
// (the roster panel's own endpoint, and the chat update_lineup_settings
// tool), both already behind the app's normal auth/lock/private-storage
// path before this runs.
function applyLineupSettings(roster, updates = {}) {
  backfillSidePreferences(roster);
  const changed = [];
  for (const role of SIDE_ROLE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(updates, role) || updates[role] === undefined) continue;
    const value = normalizeIncomingSideValue(role, updates[role]);
    roster.sidePreferences[role] = value;
    changed.push(`${role} → ${value === null ? 'no preference' : value}`);
  }
  return changed.length > 0
    ? `Saved new default side preference(s): ${changed.join(', ')}.`
    : 'No settings changes were requested.';
}

function describeSource(source) {
  return source === 'temporary' ? 'this lineup only' : 'saved default';
}

function describeValue(value) {
  if (value === 'left') return 'Left';
  if (value === 'right') return 'Right';
  return 'No preference';
}

// What actually applies to ONE lineup: a per-role override present in
// `overrides` always wins (even if it's explicitly 'none', which must be
// distinguishable from a role simply not being mentioned at all — that's
// why this takes the raw override map rather than a fully-defaulted one).
// `ignoreAll` is the "ignore side preferences for this lineup" shortcut:
// every role not otherwise overridden is treated as 'none', temporarily,
// without touching the saved roster.sidePreferences at all. Anything not
// covered by an override falls back to the roster's saved default.
function resolveEffectivePreferences(savedPreferences, overrides = {}, { ignoreAll = false } = {}) {
  const effective = {};
  for (const role of SIDE_ROLE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(overrides, role) && overrides[role] !== undefined) {
      const raw = overrides[role];
      const value = raw === 'none' ? null : raw === 'left' || raw === 'right' ? raw : null;
      effective[role] = { value, source: 'temporary' };
    } else if (ignoreAll) {
      effective[role] = { value: null, source: 'temporary' };
    } else {
      effective[role] = { value: savedPreferences?.[role] ?? null, source: 'default' };
    }
  }
  return effective;
}

function describeEffectivePreferences(effective) {
  return SIDE_ROLE_KEYS.map(
    (role) => `${role[0].toUpperCase()}${role.slice(1)} → ${describeValue(effective[role].value)} (${describeSource(effective[role].source)})`
  );
}

function averageForSide(player) {
  const s = player.skills || {};
  return ((s.offense ?? 0) + (s.defense ?? 0)) / 2;
}

// The one step that actually places players left/right without changing
// who's selected: for every left/right pair this formation has (a "3
// player group" like left_back/center_back/right_back only ever compares
// the left and right ones — the center slot is never part of a pair), if
// BOTH slots are filled with a non-exactly-pinned player, swap the two
// players' slots so the lower-average one lands on the preferred side.
// Equal averages, or no preference for that role, leave the pair exactly
// as the scheduler's normal fill already placed them — no swap at all,
// so this is a pure no-op whenever there's nothing to do. An
// exact-position pin on either side of the pair takes that whole pair out
// of consideration; the other slot's occupant (however they got there)
// simply keeps whatever slot is left, since there's nothing left to swap
// with. Mutates `lineup` in place; changes nothing else (selection,
// quarters-played bookkeeping) — playing time is decided before this ever
// runs.
function applySideAssignment(formationName, lineup, effectivePreferences) {
  const bySlotId = new Map(lineup.map((slot) => [slot.position, slot]));
  for (const group of getSidePairGroups(formationName)) {
    if (!group.left || !group.right) continue; // no pair to compare for this role/formation
    const leftSlot = bySlotId.get(group.left);
    const rightSlot = bySlotId.get(group.right);
    if (!leftSlot?.player || !rightSlot?.player) continue;
    if (leftSlot.pinKind === 'exact' || rightSlot.pinKind === 'exact') continue;

    const pref = effectivePreferences[group.role];
    if (!pref || !pref.value) continue; // no preference -> preserve normal ordering

    const leftAvg = averageForSide(leftSlot.player);
    const rightAvg = averageForSide(rightSlot.player);
    if (leftAvg === rightAvg) continue; // stable ordering on a tie

    const lowerIsOnLeft = leftAvg < rightAvg;
    const wantsLowerOnLeft = pref.value === 'left';
    if (lowerIsOnLeft !== wantsLowerOnLeft) {
      const tmp = leftSlot.player;
      leftSlot.player = rightSlot.player;
      rightSlot.player = tmp;
      // pinKind for a swapped pair is always 'generic' or null on both
      // sides (exact pins were already excluded above), so nothing else
      // needs to move with the player.
    }
  }
}

module.exports = {
  SIDE_ROLE_KEYS,
  DEFAULT_SIDE_PREFERENCES,
  backfillSidePreferences,
  applyLineupSettings,
  resolveEffectivePreferences,
  describeEffectivePreferences,
  applySideAssignment,
  averageForSide,
};
