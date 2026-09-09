// The actual game-scheduling logic for the Soccer Lineup agent: the two
// tool schemas that ask the model for constraints (set_game_lineup,
// update_lineup_settings — manage_roster stays in soccerLineup.js, since
// that one is roster CRUD, not scheduling), and computeGameLineup itself.
// Split out of soccerLineup.js per CLAUDE.md's file-size guidance, and
// because this is genuinely a separate concern from roster storage/CRUD —
// this file only ever reads a roster, never writes one.
//
// An LLM asked to fill 7 slots x 4 quarters with no repeats, while also
// enforcing AYSO's "everyone plays 3 quarters before anyone plays a 4th"
// fairness rule AND a left/right side preference, will drift on that
// bookkeeping as the roster grows. The model's only job (via
// set_game_lineup) is to turn a coach's freeform request into structured
// constraints; this file turns those into an actual, fair, valid,
// side-aware schedule.
//
// Lineup VARIETY (rotation away from recently-played roles/positions, and
// seeded randomness among similarly-suitable candidates) is layered on top
// of that same algorithm, not a separate pass — see the "suitability
// tolerance" block inside the per-slot fill loop below. It only ever
// activates when a caller supplies `constraints.seed`; every existing call
// site (and every test that predates this feature) omits it, which keeps
// this function's behavior byte-for-byte unchanged for them — no
// Math.random() call happens anywhere unless a seed is present. The one
// caller that always supplies a seed is soccerLineupHistory.js, which is
// what both the roster-panel-adjacent "generate a lineup" flow and chat
// now go through, rather than calling this function bare.
const formations = require('./soccerFormations');
const sidePrefs = require('./soccerSidePreferences');
const rotationStats = require('./soccerRotationStats');
const positionContinuity = require('./soccerPositionContinuity');
const { createRng, weightedPick } = require('./prng');
const { SET_GAME_LINEUP_TOOL, UPDATE_LINEUP_SETTINGS_TOOL } = require('./soccerSchedulingTools');
const { FORMATIONS, DEFAULT_FORMATION, POSITION_CATALOG } = formations;

// Left wing, right back, and striker specifically (2-3-1's only formation
// right now) get a coaching preference toward the team's WEAKER players,
// in that priority order — see the preferWeaker handling inside the Pass 3
// fill loop below for exactly how. A position id that doesn't exist in
// whatever formation is active (e.g. a future formation without a striker)
// simply never matches here; nothing formation-specific needed beyond that.
const WEAK_PREFERENCE_POSITIONS = ['left_wing', 'right_back', 'striker'];

const QUARTERS = [1, 2, 3, 4];

// How much more likely a goalkeeper candidate is to be picked when they
// weren't playing at all last quarter (resting or naturally benched),
// versus one who was already on the field — a coach wants advance notice
// of who's about to go in goal so there's time to warm them up, not a
// switch straight from an outfield position. Only applies in Q2 and Q4
// (the second quarter of each half) — Q1 and Q3 goalkeepers can come from
// anywhere, per the coach's own framing of when a warm-up window actually
// matters. Only ever a bias among an already suitability/fairness-eligible
// pool for the goalkeeper slot specifically (see the suitability tolerance
// block below) — "generally", not an absolute rule.
const GOALKEEPER_BENCH_PREFERENCE_BOOST = 3;

// How much more likely a candidate who's already played goalkeeper THIS
// game is to be picked for an outfield slot once they've already sat out
// one quarter — a coach doesn't want someone who's already given up a
// quarter of field time in net to lose a second one too, on top of that,
// just because they're not the best-suited outfield option. Same bounds
// as every other bias here: only among an already suitability/fairness-
// eligible pool, never a guarantee (if there's truly no way to avoid it,
// AYSO fairness — unchanged — still decides who actually sits).
const KEEPER_SECOND_BENCH_AVOIDANCE_BOOST = 4;

// How close (on the existing 1-5 role-rating scale) a candidate's
// suitability score has to be to the BEST eligible score in their fairness
// tier to still be considered for rotation/random selection. Keeps variety
// from ever picking a meaningfully worse-suited player just for the sake
// of being "fresh" — see computeGameLineup's fill loop for exactly where
// this applies (and doesn't: it never affects who's eligible under
// availability/AYSO-fairness, only which of the equally-eligible
// candidates gets the slot).
const DEFAULT_SUITABILITY_TOLERANCE = 1;

// "Off the bench" for the goalkeeper preference above means anyone who
// wasn't on the field last quarter for ANY reason — resting or naturally
// benched both count, since either way they were sitting out and could
// have been warming up. `previousQuarter` is that quarter's own record
// (`{ lineup, bench }`) or null (Q1, or no previous quarter at all).
function wasPlayingLastQuarter(player, previousQuarter) {
  if (!previousQuarter) return false;
  return previousQuarter.lineup.some((slot) => slot.player === player);
}

function findPlayerById(players, id) {
  return players.find((p) => p.id === id) || null;
}

// Would giving `player` their next quarter hand them a 4th quarter before
// every other still-available player (in this quarter) has reached 3? That's
// the one thing AYSO's fairness rule actually forbids.
function wouldViolateFairness(player, quartersPlayed, othersAvailableThisQuarter) {
  if (quartersPlayed.get(player) + 1 !== 4) return false;
  return othersAvailableThisQuarter.some((o) => o !== player && quartersPlayed.get(o) < 3);
}

// Builds one quarter's empty lineup from the formation's exact slots, each
// carrying its role (for skill scoring and generic-role pins). `pinKind`
// starts null and is set to 'exact' or 'generic' the moment a slot is
// filled by a pin — never by the fairness/skill fill below, which leaves
// it null so the slot stays eligible for side-assignment.
function buildEmptyLineup(formationName) {
  return FORMATIONS[formationName].map((positionId) => {
    const def = POSITION_CATALOG[positionId];
    return { position: positionId, role: def.role, player: null, pinKind: null, weakPreference: false };
  });
}

// Pure function: given a roster and a set of per-quarter constraints,
// returns a full 4-quarter schedule. `resting`/`pinned` reference players
// by id, not name — resolving them is the caller's job (soccerLineupChat.js
// translates the model's opaque player labels to ids before calling this),
// which keeps this function correct even when two players share a name:
// an id always means one specific player, where a name might not. Never
// throws on bad input (an id that doesn't resolve, impossible pins, too
// few players, an unrecognized position/role token) — it does the best it
// can and reports problems as `warnings`, since this is feeding an LLM's
// explanation back to a coach, not a strict API contract.
//
// Per quarter, in order: (1) resolve who's resting/available — unchanged;
// (2) exact-position pins are placed first, and are never touched again;
// (3) generic role pins are placed into any open slot of that role; (4)
// every remaining open slot is filled by the same fairness-then-skill
// selection this always used, now scored against the slot's role; (5) a
// deterministic side-assignment pass (soccerSidePreferences.js) swaps
// players between a role's left/right slots — never who's selected, only
// which of the two matching slots each one lands in — to honor the
// coach's side preference, skipping any pair touched by an exact pin.
function computeGameLineup(roster, constraints = {}) {
  const {
    formation: requestedFormation,
    resting = {},
    pinned = {},
    sideOverrides = {},
    ignoreSidePreferences = false,
    // Variety inputs — all optional, all no-ops when omitted (see the
    // file-level comment above for why that matters for backward
    // compatibility). `rotationStatsData` is the return value of
    // soccerRotationStats.buildRotationStats(); `rotationBoost` sharpens
    // the freshness bias for a temporary "rotate more" request without
    // touching `suitabilityTolerance`, which governs eligibility, not bias.
    seed = null,
    rotationStatsData = null,
    rotationBoost = 1,
    suitabilityTolerance = DEFAULT_SUITABILITY_TOLERANCE,
  } = constraints;
  const warnings = [];
  const rng = seed != null ? createRng(seed) : null;

  const formationName = formations.resolveFormationName(requestedFormation, roster.formation);
  const savedPreferences = roster.sidePreferences || sidePrefs.DEFAULT_SIDE_PREFERENCES;
  const effectivePreferences = sidePrefs.resolveEffectivePreferences(savedPreferences, sideOverrides, {
    ignoreAll: !!ignoreSidePreferences,
  });

  const quartersPlayed = new Map(roster.players.map((p) => [p, 0]));
  const quarters = [];
  let rotationInfluenced = false;

  for (const q of QUARTERS) {
    const previousQuarter = quarters.length > 0 ? quarters[quarters.length - 1] : null;
    // Q1 and Q3 goalkeepers can come from anywhere; Q2 and Q4 (the second
    // quarter of each half) specifically should come off the bench, so
    // there's time to warm them up before they go in — see
    // GOALKEEPER_BENCH_PREFERENCE_BOOST above.
    const preferBenchGoalkeeper = q === 2 || q === 4;
    // Who's already played goalkeeper in an EARLIER quarter of this same
    // game (never resets between quarters, unlike quartersPlayed's own
    // per-quarter bookkeeping) — the default is not to reuse them, see the
    // suitability-tolerance block below. And how many quarters each player
    // has already sat out so far this game (natural bench only, never a
    // requested rest — that's the coach's own choice, not something to
    // compensate for) — used to keep a former goalkeeper from losing a
    // second quarter of field time on top of their first.
    const priorGoalkeepers = new Set();
    const benchCountSoFar = new Map();
    for (const pastQuarter of quarters) {
      for (const s of pastQuarter.lineup) {
        if (s.role === 'goalkeeper' && s.player) priorGoalkeepers.add(s.player);
      }
      for (const p of pastQuarter.bench) {
        benchCountSoFar.set(p, (benchCountSoFar.get(p) || 0) + 1);
      }
    }
    const qKey = String(q);
    const restingIds = resting[qKey] || [];
    const restingPlayers = [];
    for (const id of restingIds) {
      const player = findPlayerById(roster.players, id);
      if (player) restingPlayers.push(player);
      else warnings.push(`Q${q}: a player marked resting isn't on the roster — ignored.`);
    }
    const available = roster.players.filter((p) => !restingPlayers.includes(p));

    const lineup = buildEmptyLineup(formationName);
    const usedThisQuarter = new Set();

    // Sort this quarter's pins into exact-position vs. generic-role, and
    // flag anything unrecognized — in stable (insertion) order, so pins
    // are always resolved the same way for the same input.
    const pinnedThisQuarter = pinned[qKey] || {};
    const exactPins = [];
    const genericPins = [];
    for (const [id, rawToken] of Object.entries(pinnedThisQuarter)) {
      const normalized = formations.normalizePositionToken(rawToken);
      if (!normalized) {
        warnings.push(`Q${q}: "${rawToken}" isn't a position or role this app recognizes — ignored.`);
        continue;
      }
      if (normalized.kind === 'exact') {
        if (!formations.isExactPositionValidForFormation(formationName, normalized.id)) {
          warnings.push(
            `Q${q}: ${formations.formatPositionLabel(normalized.id)} isn't part of the ${formationName} formation — ignored.`
          );
          continue;
        }
        exactPins.push([id, normalized.id]);
      } else {
        genericPins.push([id, normalized.role]);
      }
    }

    // Pass 1: exact-position pins. These are never revisited by the
    // side-assignment step below.
    for (const [id, positionId] of exactPins) {
      const player = findPlayerById(available, id);
      if (!player) {
        warnings.push(`Q${q}: a player pinned to ${formations.formatPositionLabel(positionId)} isn't available — ignored.`);
        continue;
      }
      if (usedThisQuarter.has(player)) {
        warnings.push(`Q${q}: ${player.name} was pinned more than once — used the first assignment.`);
        continue;
      }
      const slot = lineup.find((s) => s.position === positionId);
      if (slot.player) {
        warnings.push(
          `Q${q}: ${formations.formatPositionLabel(positionId)} was requested for more than one player — kept ${slot.player.name}.`
        );
        continue;
      }
      if (wouldViolateFairness(player, quartersPlayed, available.filter((o) => !usedThisQuarter.has(o)))) {
        warnings.push(
          `Q${q}: pinning ${player.name} to ${formations.formatPositionLabel(positionId)} gives them a 4th quarter before everyone else has played 3 (AYSO fairness rule) — honored anyway since you explicitly requested it.`
        );
      }
      slot.player = player;
      slot.pinKind = 'exact';
      usedThisQuarter.add(player);
    }

    // Pass 2: generic role pins — any open slot of that role, left for the
    // side-assignment step to place left/right afterward.
    for (const [id, role] of genericPins) {
      const player = findPlayerById(available, id);
      if (!player) {
        warnings.push(`Q${q}: a player pinned to ${role} isn't available — ignored.`);
        continue;
      }
      if (usedThisQuarter.has(player)) {
        warnings.push(`Q${q}: ${player.name} was pinned more than once — used the first assignment.`);
        continue;
      }
      const openSlot = lineup.find((s) => s.role === role && !s.player);
      if (!openSlot) {
        warnings.push(`Q${q}: no open ${role} slot left for ${player.name} in the ${formationName} formation — ignored.`);
        continue;
      }
      if (wouldViolateFairness(player, quartersPlayed, available.filter((o) => !usedThisQuarter.has(o)))) {
        warnings.push(
          `Q${q}: pinning ${player.name} gives them a 4th quarter before everyone else has played 3 (AYSO fairness rule) — honored anyway since you explicitly requested it.`
        );
      }
      openSlot.player = player;
      openSlot.pinKind = 'generic';
      usedThisQuarter.add(player);
    }

    // Pass 3: fairness-then-skill fill for whatever's still open. The
    // ELIGIBILITY part of this (who's even a candidate, in what priority
    // order) is exactly the algorithm this always used — unchanged whether
    // or not a seed is supplied. What changes, only when `rng` exists, is
    // which of the equally-eligible candidates actually gets the slot.
    //
    // Left wing, right back, and striker get first claim (after
    // goalkeeper — see below) on this quarter's weaker players (see
    // WEAK_PREFERENCE_POSITIONS above), in that priority order — processed
    // before every other still-open slot so that priority actually means
    // something when the same player could otherwise have filled more
    // than one of the three. Everything else fills in its normal
    // formation order afterward, from whoever's left.
    //
    // Goalkeeper always goes FIRST regardless, even ahead of the weak-
    // preference slots: its suitability-before-fairness correctness fix
    // above only works if the real goalkeeper candidate(s) haven't
    // already been claimed by some other slot first — a poor offense/
    // defense player (attractive to left_wing/striker's weak preference)
    // is very often exactly who has the standout goalie rating.
    const stillOpen = lineup.filter((slot) => !slot.player);
    const goalkeeperSlot = stillOpen.find((slot) => slot.role === 'goalkeeper');
    const weakPrioritySlots = WEAK_PREFERENCE_POSITIONS
      .map((positionId) => stillOpen.find((slot) => slot.position === positionId))
      .filter(Boolean);
    const priority = [goalkeeperSlot, ...weakPrioritySlots].filter(Boolean);
    const fillOrder = [...priority, ...stillOpen.filter((slot) => !priority.includes(slot))];
    for (const slot of fillOrder) {
      const preferWeaker = WEAK_PREFERENCE_POSITIONS.includes(slot.position);
      const remaining = available.filter((p) => !usedThisQuarter.has(p));
      if (remaining.length === 0) {
        warnings.push(`Q${q}: not enough available players to fill every ${formationName} slot.`);
        continue;
      }
      // Goalkeeper eligibility is never weakened by fairness-tier ordering:
      // whoever's been on the bench longest normally gets first claim on
      // ANY open slot (fairness before suitability, by design — see the
      // suitability-tolerance block below), but for goalkeeper specifically
      // that would let a genuinely unsuited outfield player get thrust into
      // goal for a quarter just because they sat out more recently than the
      // team's actual keeper(s). So goalkeeper suitability is filtered
      // FIRST, across everyone available (not tier-scoped), and fairness
      // only decides who plays among THOSE suitable candidates — always at
      // least one, since the best-available goalkeeper skill trivially
      // qualifies against itself. Unaffected by whether a seed is present:
      // this is a correctness fix to who's even a legitimate candidate, not
      // a variety feature.
      let candidatePool = remaining;
      if (slot.role === 'goalkeeper') {
        const bestGoalkeeperSkill = Math.max(...remaining.map((p) => formations.positionSkill(p, 'goalkeeper')));
        candidatePool = remaining.filter(
          (p) => bestGoalkeeperSkill - formations.positionSkill(p, 'goalkeeper') <= suitabilityTolerance
        );
      }
      // Unchanged: fewest-quarters-played first, skill as tiebreak — this
      // ordering alone determines who's ELIGIBLE and in what priority.
      // preferWeaker never touches this: it only ever picks a DIFFERENT
      // member of the same fairness-tied, suitability-bounded pool further
      // below, never a less fair or less suitable one — see the tolerant
      // pool below, which is what preferWeaker actually draws from.
      const sorted = [...candidatePool].sort((a, b) => {
        const qA = quartersPlayed.get(a);
        const qB = quartersPlayed.get(b);
        if (qA !== qB) return qA - qB;
        return formations.positionSkill(b, slot.role) - formations.positionSkill(a, slot.role);
      });
      const fairnessChosen = sorted.find((p) => !wouldViolateFairness(p, quartersPlayed, remaining));
      let chosen;
      if (!fairnessChosen) {
        // Nobody can take this slot without an early 4th quarter — same
        // degenerate case as before, resolved the same deterministic way
        // (no variety applied): rotation/randomness only ever operates
        // among candidates who are otherwise equally eligible, and by
        // definition nobody here is "eligible" in the normal sense. For
        // goalkeeper specifically, everyone left here is necessarily tied
        // at the same forced-4th-quarter tier (anyone with fewer quarters
        // would have been fairnessChosen instead) — the no-repeat default
        // still applies within that tie, so a keeper who hasn't played
        // goalkeeper yet is preferred over reusing one who already has.
        chosen = sorted[0];
        if (slot.role === 'goalkeeper') {
          const freshChoice = sorted.find((p) => !priorGoalkeepers.has(p));
          if (freshChoice) chosen = freshChoice;
        }
        warnings.push(`Q${q}: ${chosen.name} plays a 4th quarter before everyone else has played 3 — unavoidable given the remaining constraints.`);
      } else if (!rng && !preferWeaker) {
        // No seed supplied and this isn't a weak-preference slot: behave
        // exactly as this always did — the highest-skill, non-violating
        // member of the fewest-quarters-played tier, with ties broken by
        // original roster order.
        chosen = fairnessChosen;
      } else {
        // Candidates who share fairnessChosen's exact fairness tier (same
        // quartersPlayed count) and also don't violate the AYSO rule are
        // "equally eligible" — among THOSE, anyone within
        // `suitabilityTolerance` role-rating points of the best score in
        // that tier is a legitimate rotation candidate. fairnessChosen is
        // always a member of this pool (it's the tier's own best
        // non-violating score by construction), so this can never produce
        // a worse-suited pick than the non-seeded path would have, and
        // never expands who's eligible under availability/fairness. Both
        // seeded rotation AND preferWeaker draw only from this same
        // bounded pool — preferWeaker just picks the WORST member of it
        // instead of a weighted freshness pick, which is what keeps a
        // weak-preference slot from ever reaching for someone meaningfully
        // less suited than the tier's best, even though it's actively
        // looking for the lower-skill end of "suitable."
        const tierQ = quartersPlayed.get(fairnessChosen);
        const eligibleTier = candidatePool.filter(
          (p) => quartersPlayed.get(p) === tierQ && !wouldViolateFairness(p, quartersPlayed, remaining)
        );
        const bestSkill = Math.max(...eligibleTier.map((p) => formations.positionSkill(p, slot.role)));
        const tolerant = eligibleTier.filter((p) => bestSkill - formations.positionSkill(p, slot.role) <= suitabilityTolerance);
        if (preferWeaker) {
          // Deterministic — a skill preference, not a freshness one, so it
          // doesn't need rng even when a seed is present. Ties (more than
          // one candidate at the same lowest skill) resolve to whoever
          // comes first in roster order, same tie-break convention as the
          // rest of this function without a seed.
          chosen = tolerant.length > 1
            ? tolerant.reduce((worst, p) =>
                formations.positionSkill(p, slot.role) < formations.positionSkill(worst, slot.role) ? p : worst
              )
            : fairnessChosen;
        } else if (tolerant.length <= 1) {
          chosen = fairnessChosen;
          if (slot.role === 'goalkeeper' && priorGoalkeepers.has(chosen)) {
            warnings.push(`Q${q}: no other suitable goalkeeper was available this quarter — ${chosen.name} plays goalkeeper again this game.`);
          }
        } else {
          // Default: don't reuse a goalkeeper within the same game — only
          // ever excludes candidates from THIS slot's already-suitable
          // pool, never widens who's eligible, and only within the
          // seeded/variety path (an explicit pin, handled entirely in Pass
          // 1/2 above, always wins regardless — that's the coach directly
          // "saying otherwise"). Falls back to the full pool (with a
          // warning) if every suitable candidate has already played
          // goalkeeper — repeating one is better than forcing an unsuited
          // player into goal.
          let pool = tolerant;
          if (slot.role === 'goalkeeper') {
            const notYetGoalkeeper = tolerant.filter((p) => !priorGoalkeepers.has(p));
            if (notYetGoalkeeper.length > 0) {
              pool = notYetGoalkeeper;
            } else {
              warnings.push(`Q${q}: every otherwise-suitable goalkeeper has already played that position this game — repeating one was unavoidable.`);
            }
          }
          const weights = pool.map((p) => {
            const base = rotationStatsData
              ? rotationStats.rotationWeight(
                  rotationStats.rotationScoreFor(p.id, slot.role, slot.position, rotationStatsData),
                  rotationBoost
                )
              : 1; // no history yet — uniform weight, still genuinely random
            const benchBoost =
              slot.role === 'goalkeeper' && preferBenchGoalkeeper && !wasPlayingLastQuarter(p, previousQuarter)
                ? GOALKEEPER_BENCH_PREFERENCE_BOOST
                : 1;
            // Someone who's already played goalkeeper this game and has
            // already sat out one quarter is preferred for whatever slot
            // is open now, so they don't lose a second quarter too.
            const secondBenchAvoidance =
              priorGoalkeepers.has(p) && (benchCountSoFar.get(p) || 0) >= 1 ? KEEPER_SECOND_BENCH_AVOIDANCE_BOOST : 1;
            return base * benchBoost * secondBenchAvoidance;
          });
          chosen = weightedPick(pool, weights, rng);
          if (chosen !== fairnessChosen) rotationInfluenced = true;
        }
      }
      slot.player = chosen;
      if (preferWeaker) slot.weakPreference = true;
      usedThisQuarter.add(chosen);
    }

    // Side-assignment: never changes who's playing, only which of a
    // role's matching left/right slots each already-selected player lands
    // in — skipped entirely for any pair an exact pin touched.
    sidePrefs.applySideAssignment(formationName, lineup, effectivePreferences);

    // Position continuity (seeded path only, same as the rest of variety):
    // a continuing midfielder keeps their exact spot from last quarter
    // rather than being shuffled to a different one — runs last so it wins
    // over side-assignment's placement for anyone it applies to. Only
    // within a half: Q2 continues from Q1, and Q4 continues from Q3, but
    // Q3 never looks back at Q2 — that transition crosses the half
    // boundary, where a substitution is expected and comfort at one spot
    // matters less.
    if (rng && (q === 2 || q === 4)) {
      positionContinuity.applyPositionContinuity(lineup, previousQuarter?.lineup ?? null);
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

  const sidePreferencesApplied = sidePrefs.SIDE_ROLE_KEYS.map((role) => ({
    role,
    value: effectivePreferences[role].value,
    source: effectivePreferences[role].source,
  }));

  return { formation: formationName, quarters, quartersPlayedSummary, sidePreferencesApplied, rotationInfluenced, warnings };
}

// Renders the computed schedule as plain text for the tool result — this is
// what the model sees and explains back to the coach, so it's written to
// be readable as-is even before the model touches it. Per-quarter listing
// only (no grid/table needed), slots in formation (on-field) order with
// their exact readable label.
function formatGameLineupResult({ formation, quarters, quartersPlayedSummary, sidePreferencesApplied, warnings }) {
  const lines = [`Formation: ${formation}`, '', 'Side preferences applied this lineup:'];
  for (const entry of sidePrefs.describeEffectivePreferences(
    Object.fromEntries(sidePreferencesApplied.map((e) => [e.role, { value: e.value, source: e.source }]))
  )) {
    lines.push(`- ${entry}`);
  }
  for (const { quarter, lineup, bench } of quarters) {
    lines.push('', `Quarter ${quarter}:`);
    for (const slot of lineup) {
      const label = formations.formatPositionLabel(slot.position);
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
  SET_GAME_LINEUP_TOOL,
  UPDATE_LINEUP_SETTINGS_TOOL,
  DEFAULT_SUITABILITY_TOLERANCE,
  GOALKEEPER_BENCH_PREFERENCE_BOOST,
  KEEPER_SECOND_BENCH_AVOIDANCE_BOOST,
  computeGameLineup,
  formatGameLineupResult,
};
