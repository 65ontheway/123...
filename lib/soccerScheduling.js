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
const { FORMATIONS, DEFAULT_FORMATION, POSITION_CATALOG } = formations;

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

// The tool definition sent to OpenRouter. The model's job is limited to
// filling this in from the coach's message — it never sees or computes the
// actual player assignments. Constraints are keyed by quarter number
// ("1"-"4") since AYSO allows a free substitution between each quarter.
const SET_GAME_LINEUP_TOOL = {
  type: 'function',
  function: {
    name: 'set_game_lineup',
    description:
      'Record the constraints for a full 4-quarter 7v7 soccer game from the coach\'s request, and save it as a ' +
      'new DRAFT lineup the coach can review, regenerate, or finalize. Does not compute the lineup itself — the ' +
      'app schedules the actual game from these constraints, including AYSO\'s rule that every player plays 3 ' +
      'quarters before anyone plays a 4th, the coach\'s left/right side preferences (unless overridden here for ' +
      'this lineup only), and rotation away from what recent finalized games already covered. Always creates a ' +
      'brand-new saved game — for "another option" or "use this lineup" on an EXISTING one, use ' +
      'generate_lineup_alternative / finalize_lineup instead, referencing that game\'s id.',
    parameters: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: 'The game date in YYYY-MM-DD form, if the coach named or implied one (e.g. "Saturday"). Omit to use today.',
        },
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
            'Map of quarter number ("1"-"4") to a map of {"Player Name": "position"} for players the coach ' +
            'explicitly assigned that quarter. Position can be an exact slot (e.g. "left_back", "center_mid", ' +
            '"striker" — common aliases like "goalie" and "center midfield" are also fine) to assign that ' +
            'exact spot, or a general role ("goalkeeper", "defender", "midfielder", "forward" — e.g. "play ' +
            'Player_2 in defense") to let the app pick which exact slot within that role, applying the side ' +
            'preference below. Only use an exact slot when the coach named one specifically — a general role ' +
            'request should stay general so the side preference still applies.',
          additionalProperties: {
            type: 'object',
            additionalProperties: { type: 'string' },
          },
        },
        sideOverrides: {
          type: 'object',
          description:
            'Per-role left/right side preference for THIS LINEUP ONLY — never changes the coach\'s saved ' +
            'defaults (use update_lineup_settings for that instead). Omit a role entirely to use the coach\'s ' +
            'saved default for it. Set a role to "none" to explicitly turn off its preference for this lineup ' +
            'only (different from omitting it). Only set this when the coach said something like "for this ' +
            'game" / "just this once" / "this lineup" about a side preference.',
          properties: {
            defender: { type: 'string', enum: ['left', 'right', 'none'] },
            midfielder: { type: 'string', enum: ['left', 'right', 'none'] },
            forward: { type: 'string', enum: ['left', 'right', 'none'] },
          },
        },
        ignoreSidePreferences: {
          type: 'boolean',
          description:
            'Set true when the coach wants ALL side preferences turned off for this one lineup (e.g. "ignore ' +
            'side preferences for this game"), without changing their saved defaults. Equivalent to setting ' +
            'every role in sideOverrides to "none" — only needed as a shortcut when no specific roles were named.',
        },
      },
      required: [],
    },
  },
};

// Lets a coach persist their default side preferences for FUTURE lineups —
// kept as a separate tool from set_game_lineup on purpose, so a plain
// scheduling request can never accidentally change a saved default, and so
// a single turn that both saves a preference AND asks for a lineup ("make
// weaker defenders left my default, then schedule the game") produces two
// distinct, individually-inspectable tool calls rather than one that tries
// to do both. Only ever called when the coach explicitly asks to save or
// change a default — never for a "this lineup only" request (that's
// set_game_lineup's sideOverrides/ignoreSidePreferences instead).
const UPDATE_LINEUP_SETTINGS_TOOL = {
  type: 'function',
  function: {
    name: 'update_lineup_settings',
    description:
      'Persist the coach\'s default left/right side preference for one or more roles, for all FUTURE ' +
      'lineups. Does not generate or affect a lineup for the current request by itself — call ' +
      'set_game_lineup too (in the same turn) if the coach also asked for a lineup. Only include the ' +
      'role(s) the coach explicitly asked to change; every role left out keeps its current saved value.',
    parameters: {
      type: 'object',
      properties: {
        defender: {
          type: 'string',
          enum: ['left', 'right', 'none'],
          description: 'Which side the lower-average defender should default to. "none" means no preference.',
        },
        midfielder: {
          type: 'string',
          enum: ['left', 'right', 'none'],
          description: 'Which side the lower-average midfielder/wing should default to.',
        },
        forward: {
          type: 'string',
          enum: ['left', 'right', 'none'],
          description: 'Which side the lower-average forward should default to.',
        },
      },
      required: [],
    },
  },
};

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
    return { position: positionId, role: def.role, player: null, pinKind: null };
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
    for (const slot of lineup) {
      if (slot.player) continue;
      const remaining = available.filter((p) => !usedThisQuarter.has(p));
      if (remaining.length === 0) {
        warnings.push(`Q${q}: not enough available players to fill every ${formationName} slot.`);
        continue;
      }
      // Unchanged: fewest-quarters-played first, skill as tiebreak — this
      // ordering alone determines who's ELIGIBLE and in what priority.
      const sorted = [...remaining].sort((a, b) => {
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
        // definition nobody here is "eligible" in the normal sense.
        chosen = sorted[0];
        warnings.push(`Q${q}: ${chosen.name} plays a 4th quarter before everyone else has played 3 — unavoidable given the remaining constraints.`);
      } else if (!rng) {
        // No seed supplied: behave exactly as this always did — the
        // highest-skill, non-violating member of the fewest-quarters-played
        // tier, with ties broken by original roster order.
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
        // never expands who's eligible under availability/fairness.
        const tierQ = quartersPlayed.get(fairnessChosen);
        const eligibleTier = remaining.filter(
          (p) => quartersPlayed.get(p) === tierQ && !wouldViolateFairness(p, quartersPlayed, remaining)
        );
        const bestSkill = Math.max(...eligibleTier.map((p) => formations.positionSkill(p, slot.role)));
        const tolerant = eligibleTier.filter((p) => bestSkill - formations.positionSkill(p, slot.role) <= suitabilityTolerance);
        if (tolerant.length <= 1) {
          chosen = fairnessChosen;
        } else {
          const weights = tolerant.map((p) => {
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
            return base * benchBoost;
          });
          chosen = weightedPick(tolerant, weights, rng);
          if (chosen !== fairnessChosen) rotationInfluenced = true;
        }
      }
      slot.player = chosen;
      usedThisQuarter.add(chosen);
    }

    // Side-assignment: never changes who's playing, only which of a
    // role's matching left/right slots each already-selected player lands
    // in — skipped entirely for any pair an exact pin touched.
    sidePrefs.applySideAssignment(formationName, lineup, effectivePreferences);

    // Position continuity (seeded path only, same as the rest of variety):
    // a continuing defender/midfielder keeps their exact spot from last
    // quarter rather than being shuffled to a different one — runs last so
    // it wins over side-assignment's placement for anyone it applies to.
    if (rng) {
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
  computeGameLineup,
  formatGameLineupResult,
};
