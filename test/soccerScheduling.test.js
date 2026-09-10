const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

process.env.RAYGPT_DATA_DIR = path.join(os.tmpdir(), 'raygpt-test-scheduling-' + process.pid);

const soccerLineup = require('../lib/soccerLineup');

// A fictional 8-player roster. Fixture Left/Fixture Right are the only two
// players who stand out on defense (5 and 4 respectively — everyone else is
// deliberately bland at 1) so which two players fill left_back/right_back,
// and which of them has the lower offense+defense average, is unambiguous
// and independent of how the other 5 outfield slots happen to fill.
function buildRoster(formation = '2-3-1') {
  const roster = { formation, players: [] };
  const specs = [
    { name: 'Fixture Keeper', offense: 1, defense: 1, goalie: 5 },
    { name: 'Fixture Left', offense: 1, defense: 5, goalie: 1 }, // avg 3 (lower)
    { name: 'Fixture Right', offense: 3, defense: 4, goalie: 1 }, // avg 3.5 (higher)
    { name: 'Fixture Filler A', offense: 1, defense: 1, goalie: 1 },
    { name: 'Fixture Filler B', offense: 1, defense: 1, goalie: 1 },
    { name: 'Fixture Filler C', offense: 1, defense: 1, goalie: 1 },
    { name: 'Fixture Filler D', offense: 1, defense: 1, goalie: 1 },
    { name: 'Fixture Filler E', offense: 1, defense: 1, goalie: 1 },
  ];
  const players = specs.map((s) => soccerLineup.addPlayerDirect(roster, s));
  return { roster, players };
}

function findByName(players, name) {
  return players.find((p) => p.name === name);
}

test('soccerScheduling.js (computeGameLineup)', async (t) => {
  await t.test('every quarter fills exactly the 7 unique exact slots for the formation, one player each', () => {
    for (const formation of Object.keys(soccerLineup.FORMATIONS)) {
      const { roster } = buildRoster(formation);
      const result = soccerLineup.computeGameLineup(roster, {});
      for (const q of result.quarters) {
        const positions = q.lineup.map((s) => s.position);
        assert.strictEqual(new Set(positions).size, 7, `${formation} Q${q.quarter} should have 7 unique slots`);
        const filled = q.lineup.filter((s) => s.player);
        assert.strictEqual(new Set(filled.map((s) => s.player.id)).size, filled.length, 'no player should double-fill');
      }
    }
  });

  await t.test('by default, the weak-player preference claims left wing and right back ahead of side preference', () => {
    const { roster, players } = buildRoster('2-3-1');
    const result = soccerLineup.computeGameLineup(roster, {});
    const q1 = result.quarters[0].lineup;
    const leftWing = q1.find((s) => s.position === 'left_wing');
    const rightBack = q1.find((s) => s.position === 'right_back');
    // Of the two players who stand out at all (Fixture Left/Right), Left is
    // the weaker all-around choice for midfield (offense 1, avg 3 vs.
    // Right's avg 3.5), so left wing's weak-player preference claims them
    // first, in turn leaving Right the only real defender left for right
    // back. Both slots are marked weakPreference — the (now moot, for these
    // two specifically) side-preference step never gets a chance to
    // re-swap either of them; see soccerSidePreferences.test.js for that
    // exclusion tested directly.
    assert.strictEqual(leftWing.player.id, findByName(players, 'Fixture Left').id);
    assert.strictEqual(leftWing.weakPreference, true);
    assert.strictEqual(rightBack.player.id, findByName(players, 'Fixture Right').id);
    assert.strictEqual(rightBack.weakPreference, true);
  });

  await t.test('an exact-position pin lands the player exactly there and is honored ahead of a generic pin', () => {
    const { roster, players } = buildRoster('2-3-1');
    const filler = findByName(players, 'Fixture Filler A');
    const result = soccerLineup.computeGameLineup(roster, { pinned: { 1: { [filler.id]: 'right_wing' } } });
    const rightWing = result.quarters[0].lineup.find((s) => s.position === 'right_wing');
    assert.strictEqual(rightWing.player.id, filler.id);
  });

  await t.test('a generic role pin still lets the side-assignment step place the exact side', () => {
    const { roster, players } = buildRoster('2-3-1');
    const left = findByName(players, 'Fixture Left'); // avg 3, lower
    const right = findByName(players, 'Fixture Right'); // avg 4.5
    // Pin both defenders generically (role, not exact side) — side-assignment should still put
    // the lower-average one (Fixture Left) on the right by default.
    const result = soccerLineup.computeGameLineup(roster, {
      pinned: { 1: { [left.id]: 'defender', [right.id]: 'defender' } },
    });
    const q1 = result.quarters[0].lineup;
    assert.strictEqual(q1.find((s) => s.position === 'right_back').player.id, left.id);
    assert.strictEqual(q1.find((s) => s.position === 'left_back').player.id, right.id);
  });

  await t.test('an exact pin is never moved by side-assignment, even when it violates the preference', () => {
    const { roster, players } = buildRoster('2-3-1');
    const left = findByName(players, 'Fixture Left'); // lower average
    // Exactly pin the lower-average player to LEFT, which is the "wrong" side under the default
    // (lower-average defender -> right) preference.
    const result = soccerLineup.computeGameLineup(roster, { pinned: { 1: { [left.id]: 'left_back' } } });
    const leftBack = result.quarters[0].lineup.find((s) => s.position === 'left_back');
    assert.strictEqual(leftBack.player.id, left.id, 'the exact pin must be honored exactly as requested');
  });

  await t.test('sideOverrides applies a this-lineup-only preference without needing saved settings', () => {
    // Uses the midfielder pair in 2-2-2 (left_midfield/right_midfield) —
    // deliberately NOT left_wing or right_back, since those are governed
    // by the weak-player preference and side-assignment never gets a
    // chance to touch them (see the "weak-player preference claims left
    // wing and right back" test above). MidLow/MidHigh differ only on
    // offense, with defense left bland like every filler, so neither one
    // is remotely attractive to right_back's weak-player preference —
    // this fixture isolates side-assignment's own behavior cleanly.
    const roster = { formation: '2-2-2', players: [] };
    const specs = [
      { name: 'Fixture Keeper', offense: 1, defense: 1, goalie: 5 },
      { name: 'Fixture Filler A', offense: 1, defense: 1, goalie: 1 },
      { name: 'Fixture Filler B', offense: 1, defense: 1, goalie: 1 },
      { name: 'Fixture Filler C', offense: 1, defense: 1, goalie: 1 },
      { name: 'Fixture Filler D', offense: 1, defense: 1, goalie: 1 },
      { name: 'Fixture Filler E', offense: 1, defense: 1, goalie: 1 },
      { name: 'Fixture MidLow', offense: 3, defense: 1, goalie: 1 }, // avg 2 (lower)
      { name: 'Fixture MidHigh', offense: 5, defense: 1, goalie: 1 }, // avg 3 (higher)
    ];
    const players = specs.map((s) => soccerLineup.addPlayerDirect(roster, s));
    const midLow = findByName(players, 'Fixture MidLow');
    const midHigh = findByName(players, 'Fixture MidHigh');
    const result = soccerLineup.computeGameLineup(roster, { sideOverrides: { midfielder: 'right' } });
    const q1 = result.quarters[0].lineup;
    // Default midfielder preference is 'left' (lower average goes left);
    // overriding to 'right' should flip it for this lineup only.
    assert.strictEqual(q1.find((s) => s.position === 'right_midfield').player.id, midLow.id, 'overriding to "right" should put the lower-average player on the right');
    assert.strictEqual(q1.find((s) => s.position === 'left_midfield').player.id, midHigh.id);
    const applied = result.sidePreferencesApplied.find((e) => e.role === 'midfielder');
    assert.deepStrictEqual(applied, { role: 'midfielder', value: 'right', source: 'temporary' });
  });

  await t.test('sideOverrides "none" disables just that one role for this lineup, others still apply', () => {
    const { roster } = buildRoster('2-3-1');
    const result = soccerLineup.computeGameLineup(roster, { sideOverrides: { defender: 'none' } });
    const defenderApplied = result.sidePreferencesApplied.find((e) => e.role === 'defender');
    const midfielderApplied = result.sidePreferencesApplied.find((e) => e.role === 'midfielder');
    assert.deepStrictEqual(defenderApplied, { role: 'defender', value: null, source: 'temporary' });
    assert.deepStrictEqual(midfielderApplied, { role: 'midfielder', value: 'left', source: 'default' });
  });

  await t.test('ignoreSidePreferences disables every role for this lineup without touching the roster file', () => {
    const { roster } = buildRoster('2-3-1');
    const before = JSON.stringify(roster.sidePreferences);
    const result = soccerLineup.computeGameLineup(roster, { ignoreSidePreferences: true });
    for (const entry of result.sidePreferencesApplied) {
      assert.strictEqual(entry.value, null);
      assert.strictEqual(entry.source, 'temporary');
    }
    assert.strictEqual(JSON.stringify(roster.sidePreferences), before, 'ignoreSidePreferences must never persist');
  });

  await t.test('a saved default is picked up automatically without any per-request override', () => {
    const { roster } = buildRoster('2-3-1');
    soccerLineup.applyLineupSettings(roster, { defender: 'left' });
    const result = soccerLineup.computeGameLineup(roster, {});
    const applied = result.sidePreferencesApplied.find((e) => e.role === 'defender');
    assert.deepStrictEqual(applied, { role: 'defender', value: 'left', source: 'default' });
  });

  await t.test('changing only a side preference never changes who plays, the bench, or quarters-played totals', () => {
    // Same roster (same player ids) for both calls — computeGameLineup is
    // pure and never mutates the roster, so calling it twice is safe and
    // makes the two results directly comparable by id.
    const { roster } = buildRoster('2-3-1');
    const baseline = soccerLineup.computeGameLineup(roster, {});
    const withOverride = soccerLineup.computeGameLineup(roster, { sideOverrides: { defender: 'left', midfielder: 'right' } });
    assert.deepStrictEqual(
      baseline.quartersPlayedSummary.map((e) => ({ id: e.id, quartersPlayed: e.quartersPlayed })),
      withOverride.quartersPlayedSummary.map((e) => ({ id: e.id, quartersPlayed: e.quartersPlayed }))
    );
    for (let i = 0; i < 4; i++) {
      const basePlayers = new Set(baseline.quarters[i].lineup.filter((s) => s.player).map((s) => s.player.id));
      const overridePlayers = new Set(withOverride.quarters[i].lineup.filter((s) => s.player).map((s) => s.player.id));
      assert.deepStrictEqual(basePlayers, overridePlayers, `Q${i + 1} selected players must be identical`);
      const baseBench = new Set(baseline.quarters[i].bench.map((p) => p.id));
      const overrideBench = new Set(withOverride.quarters[i].bench.map((p) => p.id));
      assert.deepStrictEqual(baseBench, overrideBench, `Q${i + 1} bench must be identical`);
    }
  });

  await t.test('an unrecognized position token is reported as a warning and ignored, not silently substituted', () => {
    const { roster, players } = buildRoster('2-3-1');
    const p = players[1];
    const result = soccerLineup.computeGameLineup(roster, { pinned: { 1: { [p.id]: 'quarterback' } } });
    assert.ok(result.warnings.some((w) => w.includes('quarterback')));
  });

  await t.test('an exact position not valid for the chosen formation is reported and ignored', () => {
    const { roster, players } = buildRoster('3-2-1'); // no wings in this formation
    const p = players[1];
    const result = soccerLineup.computeGameLineup(roster, { pinned: { 1: { [p.id]: 'left_wing' } } });
    assert.ok(result.warnings.some((w) => w.includes('Left Wing') && w.includes('3-2-1')));
  });

  await t.test('two different players pinned to the same exact slot: first wins, conflict is explained', () => {
    const { roster, players } = buildRoster('2-3-1');
    const p1 = players[1];
    const p2 = players[2];
    const result = soccerLineup.computeGameLineup(roster, { pinned: { 1: { [p1.id]: 'left_back', [p2.id]: 'left_back' } } });
    const leftBack = result.quarters[0].lineup.find((s) => s.position === 'left_back');
    assert.strictEqual(leftBack.player.id, p1.id, 'first pin in iteration order wins');
    assert.ok(result.warnings.some((w) => w.includes('Left Back') && w.includes('more than one player')));
  });

  await t.test('an exact pin can still violate the AYSO fairness rule with a warning, honored anyway (unchanged behavior)', () => {
    const { roster, players } = buildRoster('2-3-1');
    const target = players[1];
    // Force target to have already played 3 quarters by resting everyone else for 3 quarters.
    const others = players.filter((p) => p.id !== target.id).map((p) => p.id);
    const result = soccerLineup.computeGameLineup(roster, {
      resting: { 1: others, 2: others, 3: others },
      pinned: { 4: { [target.id]: 'left_back' } },
    });
    assert.strictEqual(result.quartersPlayedSummary.find((e) => e.id === target.id).quartersPlayed, 4);
    assert.ok(result.warnings.some((w) => w.includes('4th quarter') && w.includes('honored anyway')));
  });

  await t.test('a resting player is reported separately from the bench, not silently dropped from the quarter entirely', () => {
    // Regression: a resting player is excluded from `available` before
    // `bench` is computed (bench = available minus who's actually used),
    // so without its own field they never appeared in EITHER list for
    // that quarter — a coach counting names would come up short with no
    // explanation why, reading as a scheduling bug rather than their own
    // resting request.
    const { roster, players } = buildRoster('2-3-1'); // 8 players, 7 slots
    const resting = players[0];
    const result = soccerLineup.computeGameLineup(roster, { resting: { 1: [resting.id] } });
    const q1 = result.quarters[0];
    assert.strictEqual(q1.lineup.filter((s) => s.player).length, 7, 'all 7 slots still fill from the other 7 players');
    assert.deepStrictEqual(q1.bench.map((p) => p.id), [], 'the resting player is not the bench (nobody else was left over)');
    assert.deepStrictEqual(q1.resting.map((p) => p.id), [resting.id]);
    const text = soccerLineup.formatGameLineupResult(result);
    assert.ok(text.includes(`Resting: ${resting.name}`), 'the formatted text must call out who is resting, not just omit them');
  });

  await t.test('center positions (center_back, center_mid) are never touched by side-assignment', () => {
    const { roster } = buildRoster('3-2-1');
    const result = soccerLineup.computeGameLineup(roster, { sideOverrides: { defender: 'left' } });
    // Just confirm the center slot got filled and the formation's shape held — the real behavior
    // (center excluded from the swap) is covered directly in soccerSidePreferences.test.js.
    const centerBack = result.quarters[0].lineup.find((s) => s.position === 'center_back');
    assert.ok(centerBack.player);
  });

  t.after(() => {
    require('node:fs').rmSync(process.env.RAYGPT_DATA_DIR, { recursive: true, force: true });
  });
});
