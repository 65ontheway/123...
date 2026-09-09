// Post-processing pass for the Soccer Lineup scheduler's seeded variety
// path (see soccerScheduling.js's file header for the activation rule this
// follows — only ever runs when a seed is present, same as rotation/
// suitability variety): when a player plays midfielder in two CONSECUTIVE
// quarters, keep them at the exact same position for the second quarter
// rather than letting the normal fill/side-assignment logic shuffle them
// to a different spot within that role — e.g. left_wing both quarters, not
// left_wing then center_mid. The coach explicitly wants this to win even
// when it produces a very slightly less optimal lineup: staying
// comfortable at one spot matters more than a marginal skill gain from
// reshuffling. Deliberately scoped to a role staying the SAME across the
// two quarters — a player whose role itself changes between quarters
// (e.g. midfielder last quarter, defender this quarter) is a rotation
// decision this module has no opinion on and never touches.
//
// Scoped to midfielder only — defender is deliberately excluded, per the
// coach's own follow-up narrowing this from an earlier, broader version
// that covered both roles. The caller (soccerScheduling.js) also only ever
// invokes this for a within-half transition (Q1->Q2 or Q3->Q4, never
// Q2->Q3) — this module itself has no notion of which quarter it's
// running for, so that half-boundary rule lives entirely at the call site.
//
// This never changes WHO is selected to play or benched — only, among an
// already-selected group of continuing midfielders, which exact slot each
// one lands in — so it composes the same way side-assignment does (a pure
// re-arrangement after selection, not a selection decision). Runs AFTER
// side-assignment and simply overrides its placement for any continuing
// player who has a home to return to: continuity is the coach's explicit
// ask, so it wins over the side-preference heuristic for those players
// specifically, while every other slot (new subs off the bench, a role
// change, a player with no midfielder history from last quarter) keeps
// whatever side-assignment already decided.
//
// Only ever touches a slot the fully automatic fill logic produced
// (pinKind === null, i.e. not set by Pass 1/2 above): an exact OR generic
// pin is the coach's explicit instruction for THIS quarter and always
// wins, even over continuity — pinned slots are excluded from both ends of
// the swap (never moved, and never displaced to make room for someone
// else's continuity).
const CONTINUITY_ROLES = new Set(['midfielder']);

// `previousLineup` is the IMMEDIATELY preceding quarter's own `lineup`
// array (or null/undefined for Q1, or for a player who rested/benched the
// quarter before — "two quarters in a ROW" never looks further back than
// one quarter). Mutates `lineup` in place; returns nothing.
function applyPositionContinuity(lineup, previousLineup) {
  if (!previousLineup) return;

  const previousByPlayerId = new Map();
  for (const slot of previousLineup) {
    if (slot.player && CONTINUITY_ROLES.has(slot.role)) {
      previousByPlayerId.set(slot.player.id, { role: slot.role, position: slot.position });
    }
  }
  if (previousByPlayerId.size === 0) return;

  const movable = lineup.filter((s) => CONTINUITY_ROLES.has(s.role) && s.pinKind == null && s.player);
  if (movable.length === 0) return;
  const byPosition = new Map(movable.map((s) => [s.position, s]));

  // Bounded by the number of movable slots: a chain or cycle of several
  // continuing players trading places back into their own previous slots
  // still fully resolves within that many passes (each pass places at
  // least one more player correctly, or is a no-op and the loop stops).
  for (let pass = 0; pass < movable.length; pass++) {
    let changed = false;
    for (const slot of movable) {
      const previous = previousByPlayerId.get(slot.player.id);
      // Only a same-role continuation counts as "two quarters in a row in
      // that role" — a role change between quarters is a rotation
      // decision this pass never second-guesses.
      if (!previous || previous.role !== slot.role || previous.position === slot.position) continue;
      const target = byPosition.get(previous.position);
      if (!target || target === slot) continue;
      const displaced = target.player;
      target.player = slot.player;
      slot.player = displaced;
      changed = true;
    }
    if (!changed) break;
  }
}

module.exports = { CONTINUITY_ROLES, applyPositionContinuity };
