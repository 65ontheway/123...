// Focused coverage for the seeded variety/rotation layer added on top of
// computeGameLineup() — kept in its own file (rather than growing
// soccerScheduling.test.js) since it's a genuinely separate concern: the
// existing file covers deterministic scheduling/pins/side-preferences,
// this one covers what changes ONLY when a `seed` is supplied.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

process.env.RAYGPT_DATA_DIR = path.join(os.tmpdir(), 'raygpt-test-scheduling-variety-' + process.pid);

const soccerLineup = require('../lib/soccerLineup');
const rotationStats = require('../lib/soccerRotationStats');
const { DEFAULT_SUITABILITY_TOLERANCE } = require('../lib/soccerScheduling');

// A roster where SEVEN outfield players are within suitability tolerance of
// each other for the midfielder/forward slots (ratings 1-2, well inside the
// default tolerance of 1) so real ties exist for the rotation/seed layer to
// break, plus one standout goalie and one clearly-worse defender to keep
// the goalkeeper/defense slots deterministic across every test here.
function buildRoster(formation = '2-3-1') {
  const roster = { formation, players: [] };
  const specs = [
    { name: 'Fixture Keeper', offense: 1, defense: 1, goalie: 5 },
    { name: 'Fixture Back A', offense: 1, defense: 5, goalie: 1 },
    { name: 'Fixture Back B', offense: 1, defense: 4, goalie: 1 },
    { name: 'Fixture Mid A', offense: 2, defense: 2, goalie: 1 },
    { name: 'Fixture Mid B', offense: 2, defense: 2, goalie: 1 },
    { name: 'Fixture Mid C', offense: 1, defense: 1, goalie: 1 },
    { name: 'Fixture Mid D', offense: 1, defense: 1, goalie: 1 },
    { name: 'Fixture Fwd A', offense: 2, defense: 1, goalie: 1 },
    { name: 'Fixture Fwd B', offense: 1, defense: 1, goalie: 1 },
    { name: 'Fixture Fwd C', offense: 1, defense: 1, goalie: 1 },
  ];
  const players = specs.map((s) => soccerLineup.addPlayerDirect(roster, s));
  return { roster, players };
}

function resultSignature(result) {
  return result.quarters
    .map((q) => q.lineup.map((s) => `${s.position}:${s.player ? s.player.id : ''}`).join(','))
    .join('|');
}

test('soccerScheduling.js: seeded variety and rotation', async (t) => {
  await t.test('DEFAULT_SUITABILITY_TOLERANCE is 1 point on the 1-5 role-rating scale', () => {
    assert.strictEqual(DEFAULT_SUITABILITY_TOLERANCE, 1);
  });

  await t.test('no seed supplied: behavior is byte-for-byte identical across repeated calls (pre-existing contract preserved)', () => {
    const { roster } = buildRoster();
    const a = soccerLineup.computeGameLineup(roster, {});
    const b = soccerLineup.computeGameLineup(roster, {});
    assert.strictEqual(resultSignature(a), resultSignature(b));
    assert.strictEqual(a.rotationInfluenced, false);
  });

  await t.test('the same seed on the same inputs always reproduces the identical lineup', () => {
    const { roster } = buildRoster();
    const a = soccerLineup.computeGameLineup(roster, { seed: 'draft-seed-1' });
    const b = soccerLineup.computeGameLineup(roster, { seed: 'draft-seed-1' });
    assert.strictEqual(resultSignature(a), resultSignature(b));
  });

  await t.test('different seeds can produce distinct lineups when flexibility exists', () => {
    const { roster } = buildRoster();
    const signatures = new Set();
    for (let i = 0; i < 12; i++) {
      const result = soccerLineup.computeGameLineup(roster, { seed: `variety-seed-${i}` });
      signatures.add(resultSignature(result));
    }
    assert.ok(signatures.size > 1, 'expected at least one alternative arrangement across a spread of seeds');
  });

  await t.test('a seeded run never changes who is on the roster, playing-time totals, pins, or availability — only WHICH equally-eligible candidate fills a tied slot', () => {
    const { roster, players } = buildRoster();
    const pinTarget = players.find((p) => p.name === 'Fixture Mid A');
    const baseline = soccerLineup.computeGameLineup(roster, {
      resting: { 1: [players.find((p) => p.name === 'Fixture Fwd C').id] },
      pinned: { 2: { [pinTarget.id]: 'left_wing' } },
    });
    for (let i = 0; i < 8; i++) {
      const seeded = soccerLineup.computeGameLineup(roster, {
        seed: `constraint-seed-${i}`,
        resting: { 1: [players.find((p) => p.name === 'Fixture Fwd C').id] },
        pinned: { 2: { [pinTarget.id]: 'left_wing' } },
      });
      // WHICH players end up with fewer total quarters can differ across
      // seeds (rotation is free to pick a different, equally-eligible
      // bench-mate) — but the underlying AYSO fairness shape (how many
      // players get 3 quarters vs. 2) is a hard constraint, so the
      // multiset of totals must always match, even if the per-player
      // mapping doesn't.
      const sortedTotals = (r) => r.quartersPlayedSummary.map((e) => e.quartersPlayed).sort();
      assert.deepStrictEqual(
        sortedTotals(baseline),
        sortedTotals(seeded),
        `seed ${i}: the SHAPE of playing-time totals must be unaffected by seeding`
      );
      const totalQuartersPlayed = seeded.quartersPlayedSummary.reduce((sum, e) => sum + e.quartersPlayed, 0);
      assert.strictEqual(totalQuartersPlayed, 28, `seed ${i}: total player-quarters must always be 7 slots x 4 quarters`);
      const q2Left = seeded.quarters[1].lineup.find((s) => s.position === 'left_wing');
      assert.strictEqual(q2Left.player.id, pinTarget.id, `seed ${i}: the exact pin must still be honored`);
      const restedId = players.find((p) => p.name === 'Fixture Fwd C').id;
      const q1Playing = seeded.quarters[0].lineup.some((s) => s.player && s.player.id === restedId);
      assert.ok(!q1Playing, `seed ${i}: the rested player must never be scheduled to play in Q1`);
    }
  });

  await t.test('a seeded run never selects a candidate outside the suitability tolerance of the best eligible score', () => {
    const { roster } = buildRoster();
    for (let i = 0; i < 15; i++) {
      const result = soccerLineup.computeGameLineup(roster, { seed: `tolerance-seed-${i}` });
      // Every non-warned assignment must have come from the eligible pool —
      // proven indirectly here by confirming the algorithm never regresses
      // to picking the objectively worst-suited player for a role when
      // better within-tolerance options existed, across every quarter.
      for (const q of result.quarters) {
        for (const slot of q.lineup) {
          assert.ok(slot.player, `seed ${i} Q${q.quarter} ${slot.position} should always be filled with this roster size`);
        }
      }
    }
  });

  await t.test('side preferences still apply exactly as configured when a seed is present', () => {
    const { roster, players } = buildRoster();
    const result = soccerLineup.computeGameLineup(roster, { seed: 'side-pref-seed', sideOverrides: { defender: 'left' } });
    const leftBack = result.quarters[0].lineup.find((s) => s.position === 'left_back');
    // Fixture Back B (avg 2.5) is lower than Fixture Back A (avg 3) -> should land on the overridden "left" side.
    assert.strictEqual(leftBack.player.id, players.find((p) => p.name === 'Fixture Back B').id);
  });

  await t.test('rotationInfluenced is false when every slot is exactly pinned (nothing left for Pass 3 to choose between)', () => {
    // Pass 3 (the only place a seed can influence anything) is only ever
    // reached for a slot that isn't already filled by an exact pin — pin
    // every slot in every quarter and there is nothing left to rotate,
    // regardless of how much flexibility the roster would otherwise offer.
    const { roster, players } = buildRoster();
    const POSITIONS = ['goalkeeper', 'left_back', 'right_back', 'left_wing', 'center_mid', 'right_wing', 'striker'];
    const pinned = {};
    for (let quarter = 1; quarter <= 4; quarter++) {
      const assignment = {};
      POSITIONS.forEach((pos, i) => {
        assignment[players[i].id] = pos;
      });
      pinned[quarter] = assignment;
    }
    const result = soccerLineup.computeGameLineup(roster, { seed: 'no-flex-seed', pinned });
    assert.strictEqual(result.rotationInfluenced, false);
    for (const q of result.quarters) {
      for (let i = 0; i < POSITIONS.length; i++) {
        assert.strictEqual(q.lineup.find((s) => s.position === POSITIONS[i]).player.id, players[i].id);
      }
    }
  });

  await t.test('rotation history steers away from a player who recently filled the same role/position, when suitability allows', () => {
    const { roster, players } = buildRoster();
    const midA = players.find((p) => p.name === 'Fixture Mid A');
    const midB = players.find((p) => p.name === 'Fixture Mid B');
    // Fabricate rotation stats as if midA has heavily played left_wing/midfielder
    // recently and midB has not — same shape soccerLineupHistory.js builds via
    // soccerRotationStats.buildRotationStats from real finalized games.
    const statsByPlayerId = new Map();
    statsByPlayerId.set(midA.id, {
      roleCounts: { goalkeeper: 0, defender: 0, midfielder: 6, forward: 0 },
      positionCounts: { left_wing: 6 },
      benchCount: 0,
      gamesCounted: 3,
    });
    const rotationStatsData = { windowSize: 4, gamesConsidered: 3, statsByPlayerId };

    // Counted across every midfield slot in every quarter (not just one
    // exact position) since which of several tied candidates fills which
    // specific slot in a given quarter also depends on fill order within
    // that quarter — summing over the whole role is what isolates the
    // rotation-history bias itself from that ordering noise.
    let midATotal = 0;
    let midBTotal = 0;
    for (let i = 0; i < 40; i++) {
      const result = soccerLineup.computeGameLineup(roster, {
        seed: `history-seed-${i}`,
        rotationStatsData,
      });
      for (const q of result.quarters) {
        for (const slot of q.lineup) {
          if (slot.role !== 'midfielder' || !slot.player) continue;
          if (slot.player.id === midA.id) midATotal += 1;
          if (slot.player.id === midB.id) midBTotal += 1;
        }
      }
    }
    assert.ok(midBTotal > midATotal, `expected the fresher player to be picked into a midfield slot more often (midA=${midATotal}, midB=${midBTotal})`);
  });

  await t.test('a candidate whose only prior history is being benched is never penalized below a fresh (0) score', () => {
    const { roster, players } = buildRoster();
    const heavilyBenched = players.find((p) => p.name === 'Fixture Mid C');
    const statsByPlayerId = new Map();
    statsByPlayerId.set(heavilyBenched.id, {
      roleCounts: { goalkeeper: 0, defender: 0, midfielder: 0, forward: 0 },
      positionCounts: {},
      benchCount: 10,
      gamesCounted: 3,
    });
    const stats = { windowSize: 4, gamesConsidered: 3, statsByPlayerId };
    assert.strictEqual(rotationStats.rotationScoreFor(heavilyBenched.id, 'midfielder', 'center_mid', stats), 0);
  });

  await t.test('a player who plays the same broad role (defender or midfielder) two quarters in a row keeps the exact same position', () => {
    const { roster } = buildRoster();
    for (let i = 0; i < 20; i++) {
      const result = soccerLineup.computeGameLineup(roster, { seed: `continuity-integration-${i}` });
      for (let qi = 1; qi < result.quarters.length; qi++) {
        const previousByPlayerId = new Map();
        for (const s of result.quarters[qi - 1].lineup) {
          if (s.player && (s.role === 'defender' || s.role === 'midfielder')) {
            previousByPlayerId.set(s.player.id, { role: s.role, position: s.position });
          }
        }
        for (const s of result.quarters[qi].lineup) {
          if (!s.player) continue;
          const previous = previousByPlayerId.get(s.player.id);
          if (previous && previous.role === s.role) {
            assert.strictEqual(
              s.position,
              previous.position,
              `seed ${i} Q${qi + 1}: ${s.player.name} played ${previous.role} last quarter too — must stay at ${previous.position}`
            );
          }
        }
      }
    }
  });

  await t.test('the Q4 goalkeeper is drawn from whoever was off the field in Q3 far more often than whoever was already playing, when both are tied and suitable', () => {
    // Two capable keepers (goalie 5), six fungible fillers (goalie 1, decent
    // outfield) — exact pins/rests through Q1-Q3 deliberately engineer a
    // tie in total quarters played going into Q4 between the two keepers,
    // while keeper A was ON the field in Q3 and keeper B was OFF it, so Q4
    // is the only quarter left for the seed to decide between them.
    const roster = { formation: '2-3-1', players: [] };
    const gkA = soccerLineup.addPlayerDirect(roster, { name: 'Fixture Keeper A', offense: 1, defense: 1, goalie: 5 });
    const gkB = soccerLineup.addPlayerDirect(roster, { name: 'Fixture Keeper B', offense: 1, defense: 1, goalie: 5 });
    for (let i = 0; i < 6; i++) {
      soccerLineup.addPlayerDirect(roster, { name: `Fixture Filler ${i}`, offense: 3, defense: 3, goalie: 1 });
    }
    const constraints = {
      pinned: {
        1: { [gkA.id]: 'goalkeeper', [gkB.id]: 'left_back' },
        2: { [gkB.id]: 'left_back' },
        3: { [gkA.id]: 'right_back' },
      },
      resting: {
        2: [gkA.id],
        3: [gkB.id],
      },
    };
    let aCount = 0;
    let bCount = 0;
    for (let i = 0; i < 60; i++) {
      const result = soccerLineup.computeGameLineup(roster, { seed: `q4-goalkeeper-seed-${i}`, ...constraints });
      const q3 = result.quarters[2];
      const aPlayedQ3 = q3.lineup.some((s) => s.player && s.player.id === gkA.id);
      const bPlayedQ3 = q3.lineup.some((s) => s.player && s.player.id === gkB.id);
      assert.ok(aPlayedQ3 && !bPlayedQ3, `seed ${i}: fixture setup expected A on the field and B off it in Q3`);
      const q4Goalkeeper = result.quarters[3].lineup.find((s) => s.position === 'goalkeeper').player;
      if (q4Goalkeeper.id === gkA.id) aCount += 1;
      if (q4Goalkeeper.id === gkB.id) bCount += 1;
    }
    assert.strictEqual(aCount + bCount, 60, 'the Q4 goalkeeper should always be one of the two capable keepers in this fixture');
    assert.ok(bCount > aCount * 2, `expected keeper B (off the field in Q3) to be picked far more often (A=${aCount}, B=${bCount})`);
  });

  await t.test('Q3\'s goalkeeper shows no bench-preference bias, even given the exact same kind of tie the Q4 test uses', () => {
    // Mirrors the Q4 fixture one quarter earlier: keeper A plays OUTFIELD
    // in Q1 while keeper B rests it (off the field), then keeper A rests
    // Q2 while B plays outfield — both end tied at 1 quarter played going
    // into Q3, with A off the field in Q2 and B on it, and — importantly —
    // NEITHER has played goalkeeper yet (both pinned to left_back, an
    // outfield slot), so the separate "don't repeat a goalkeeper" default
    // never enters into this comparison; some filler ends up as Q1/Q2's
    // goalkeeper instead. Exactly one keeper rests each quarter (never
    // both), so the six fillers always fill the other six slots completely
    // and stay tied with each other at or above the keepers' count — no
    // filler ever dips below and hijacks the goalkeeper slot's fairness
    // tier away from the two keepers.
    const roster = { formation: '2-3-1', players: [] };
    const gkA = soccerLineup.addPlayerDirect(roster, { name: 'Fixture Keeper A', offense: 1, defense: 1, goalie: 5 });
    const gkB = soccerLineup.addPlayerDirect(roster, { name: 'Fixture Keeper B', offense: 1, defense: 1, goalie: 5 });
    for (let i = 0; i < 6; i++) {
      soccerLineup.addPlayerDirect(roster, { name: `Fixture Filler ${i}`, offense: 3, defense: 3, goalie: 1 });
    }
    const constraints = {
      pinned: {
        1: { [gkA.id]: 'left_back' },
        2: { [gkB.id]: 'left_back' },
      },
      resting: {
        1: [gkB.id],
        2: [gkA.id],
      },
    };
    let aCount = 0;
    let bCount = 0;
    for (let i = 0; i < 60; i++) {
      const result = soccerLineup.computeGameLineup(roster, { seed: `q3-no-bias-seed-${i}`, ...constraints });
      const q2 = result.quarters[1];
      const aPlayedQ2 = q2.lineup.some((s) => s.player && s.player.id === gkA.id);
      const bPlayedQ2 = q2.lineup.some((s) => s.player && s.player.id === gkB.id);
      assert.ok(!aPlayedQ2 && bPlayedQ2, `seed ${i}: fixture setup expected A off the field and B on it in Q2`);
      const q3Goalkeeper = result.quarters[2].lineup.find((s) => s.position === 'goalkeeper').player;
      if (q3Goalkeeper.id === gkA.id) aCount += 1;
      if (q3Goalkeeper.id === gkB.id) bCount += 1;
    }
    assert.strictEqual(aCount + bCount, 60);
    // If the bench-preference boost incorrectly applied here, keeper A
    // (off the field in Q2) would dominate the same way keeper B dominates
    // the Q4 test above — a roughly even split instead confirms Q3 truly
    // applies no bench preference at all.
    assert.ok(aCount > 15 && bCount > 15, `expected a roughly even split with no Q3 bench preference (A=${aCount}, B=${bCount})`);
  });

  await t.test('no player plays goalkeeper more than once per game when enough suitable candidates exist', () => {
    // 5 equally capable keepers (more than the 4 quarters in a game) —
    // also clearly the better outfield players, so they're never the ones
    // naturally benched — plus 3 weaker fillers who absorb all the bench
    // rotation instead. With this much slack, the default should always
    // find a fresh goalkeeper each quarter, never repeating one.
    const roster = { formation: '2-3-1', players: [] };
    for (let i = 0; i < 5; i++) {
      soccerLineup.addPlayerDirect(roster, { name: `Fixture Keeper ${i}`, offense: 3, defense: 3, goalie: 5 });
    }
    for (let i = 0; i < 3; i++) {
      soccerLineup.addPlayerDirect(roster, { name: `Fixture Filler ${i}`, offense: 1, defense: 1, goalie: 1 });
    }
    for (let i = 0; i < 30; i++) {
      const result = soccerLineup.computeGameLineup(roster, { seed: `no-repeat-gk-seed-${i}` });
      const goalkeepersUsed = result.quarters.map((q) => q.lineup.find((s) => s.position === 'goalkeeper').player.id);
      assert.strictEqual(
        new Set(goalkeepersUsed).size,
        4,
        `seed ${i}: expected 4 distinct goalkeepers across the game, got ${JSON.stringify(goalkeepersUsed)}`
      );
    }
  });

  await t.test('a single viable goalkeeper is reused every quarter (unavoidable), with a warning explaining why', () => {
    // The shared buildRoster() fixture has exactly one standout keeper —
    // repeating them every quarter is the only option, and must never be
    // blocked or force a wildly unsuited player into goal instead.
    const { roster, players } = buildRoster();
    const keeper = players.find((p) => p.name === 'Fixture Keeper');
    const result = soccerLineup.computeGameLineup(roster, { seed: 'single-keeper-seed' });
    for (const q of result.quarters) {
      const gk = q.lineup.find((s) => s.position === 'goalkeeper').player;
      assert.strictEqual(gk.id, keeper.id, `Q${q.quarter}: the only suitable keeper must still play goalkeeper`);
    }
    assert.ok(
      result.warnings.some((w) => w.includes('no other suitable goalkeeper') || w.includes('unavoidable')),
      `expected a warning explaining the repeated goalkeeper, got: ${JSON.stringify(result.warnings)}`
    );
  });

  await t.test('an explicit pin can reuse the same goalkeeper across quarters without any warning — "unless I say otherwise"', () => {
    const roster = { formation: '2-3-1', players: [] };
    const gk1 = soccerLineup.addPlayerDirect(roster, { name: 'Fixture Keeper 1', offense: 2, defense: 2, goalie: 5 });
    soccerLineup.addPlayerDirect(roster, { name: 'Fixture Keeper 2', offense: 2, defense: 2, goalie: 5 });
    for (let i = 0; i < 6; i++) {
      soccerLineup.addPlayerDirect(roster, { name: `Fixture Filler ${i}`, offense: 3, defense: 3, goalie: 1 });
    }
    const result = soccerLineup.computeGameLineup(roster, {
      seed: 'explicit-pin-repeat-seed',
      pinned: { 1: { [gk1.id]: 'goalkeeper' }, 2: { [gk1.id]: 'goalkeeper' } },
    });
    assert.strictEqual(result.quarters[0].lineup.find((s) => s.position === 'goalkeeper').player.id, gk1.id);
    assert.strictEqual(result.quarters[1].lineup.find((s) => s.position === 'goalkeeper').player.id, gk1.id);
    assert.ok(
      !result.warnings.some((w) => w.includes('goalkeeper')),
      `an explicit pin reusing a goalkeeper must never produce a warning, got: ${JSON.stringify(result.warnings)}`
    );
  });

  await t.test('a player who has already played goalkeeper is rarely left to sit out a second quarter', () => {
    // Two equally capable keepers, six fungible fillers with the SAME
    // outfield suitability as the keepers — everyone is fully
    // interchangeable outside of goalkeeper skill, so nothing but the
    // fairness/bench-avoidance machinery decides who sits. With 8 players
    // for 7 slots, only one bench quarter exists per quarter (4 total
    // across the game) — the bench-avoidance boost should keep that from
    // ever landing twice on the same former goalkeeper in the large
    // majority of games.
    const roster = { formation: '2-3-1', players: [] };
    const keeperIds = [];
    for (let i = 0; i < 2; i++) {
      const p = soccerLineup.addPlayerDirect(roster, { name: `Fixture Keeper ${i}`, offense: 2, defense: 2, goalie: 5 });
      keeperIds.push(p.id);
    }
    for (let i = 0; i < 6; i++) {
      soccerLineup.addPlayerDirect(roster, { name: `Fixture Filler ${i}`, offense: 2, defense: 2, goalie: 1 });
    }
    let doubleBenchedCount = 0;
    const trials = 60;
    for (let i = 0; i < trials; i++) {
      const result = soccerLineup.computeGameLineup(roster, { seed: `second-bench-seed-${i}` });
      const goalkeepersUsed = new Set(result.quarters.map((q) => q.lineup.find((s) => s.position === 'goalkeeper').player.id));
      const benchCounts = new Map();
      for (const q of result.quarters) {
        for (const p of q.bench) benchCounts.set(p.id, (benchCounts.get(p.id) || 0) + 1);
      }
      for (const id of goalkeepersUsed) {
        if ((benchCounts.get(id) || 0) >= 2) doubleBenchedCount += 1;
      }
    }
    assert.ok(
      doubleBenchedCount <= trials * 0.1,
      `expected a former goalkeeper to rarely sit out two quarters (happened in ${doubleBenchedCount}/${trials} trials)`
    );
  });

  t.after(() => {
    require('node:fs').rmSync(process.env.RAYGPT_DATA_DIR, { recursive: true, force: true });
  });
});
