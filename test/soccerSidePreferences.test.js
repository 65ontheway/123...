const test = require('node:test');
const assert = require('node:assert/strict');

const { RosterValidationError } = require('../lib/soccerFormations');
const sidePrefs = require('../lib/soccerSidePreferences');

function playerWith(offense, defense) {
  return { skills: { offense, defense, goalie: 1 } };
}

test('soccerSidePreferences.js', async (t) => {
  await t.test('default preferences: defender right, midfielder left, forward none', () => {
    assert.deepStrictEqual(sidePrefs.DEFAULT_SIDE_PREFERENCES, { defender: 'right', midfielder: 'left', forward: null });
  });

  await t.test('backfillSidePreferences fills a completely missing roster (older roster, no data lost)', () => {
    const roster = { formation: '2-3-1', players: [{ id: 'p1', name: 'Fixture Alpha' }] };
    const changed = sidePrefs.backfillSidePreferences(roster);
    assert.strictEqual(changed, true);
    assert.deepStrictEqual(roster.sidePreferences, sidePrefs.DEFAULT_SIDE_PREFERENCES);
    assert.strictEqual(roster.players[0].name, 'Fixture Alpha', 'existing roster data must be untouched');
  });

  await t.test('backfillSidePreferences only fills missing keys, leaving an explicitly-set one alone', () => {
    const roster = { formation: '2-3-1', players: [], sidePreferences: { defender: 'left' } };
    const changed = sidePrefs.backfillSidePreferences(roster);
    assert.strictEqual(changed, true);
    assert.strictEqual(roster.sidePreferences.defender, 'left', 'an already-set preference must not be overwritten');
    assert.strictEqual(roster.sidePreferences.midfielder, 'left');
    assert.strictEqual(roster.sidePreferences.forward, null);
  });

  await t.test('backfillSidePreferences is a no-op (reports unchanged) once a roster is fully migrated', () => {
    const roster = { formation: '2-3-1', players: [], sidePreferences: { defender: 'right', midfielder: 'left', forward: null } };
    assert.strictEqual(sidePrefs.backfillSidePreferences(roster), false);
  });

  await t.test('backfillSidePreferences replaces a malformed value rather than crashing later', () => {
    const roster = { formation: '2-3-1', players: [], sidePreferences: { defender: 'sideways', midfielder: 'left', forward: null } };
    assert.strictEqual(sidePrefs.backfillSidePreferences(roster), true);
    assert.strictEqual(roster.sidePreferences.defender, 'right');
  });

  await t.test('applyLineupSettings persists only the roles given, preserving the others', () => {
    const roster = { formation: '2-3-1', players: [] };
    const msg = sidePrefs.applyLineupSettings(roster, { defender: 'left' });
    assert.match(msg, /defender/);
    assert.strictEqual(roster.sidePreferences.defender, 'left');
    assert.strictEqual(roster.sidePreferences.midfielder, 'left', 'unspecified roles must keep the default');
    assert.strictEqual(roster.sidePreferences.forward, null);
  });

  await t.test('applyLineupSettings("none") persists explicit no-preference, distinct from never having set it', () => {
    const roster = { formation: '2-3-1', players: [] };
    sidePrefs.applyLineupSettings(roster, { midfielder: 'none' });
    assert.strictEqual(roster.sidePreferences.midfielder, null);
  });

  await t.test('applyLineupSettings rejects an invalid side value', () => {
    const roster = { formation: '2-3-1', players: [] };
    assert.throws(() => sidePrefs.applyLineupSettings(roster, { defender: 'sideways' }), RosterValidationError);
  });

  await t.test('resolveEffectivePreferences: no overrides falls back to saved defaults', () => {
    const saved = { defender: 'right', midfielder: 'left', forward: null };
    const effective = sidePrefs.resolveEffectivePreferences(saved, {});
    assert.deepStrictEqual(effective.defender, { value: 'right', source: 'default' });
    assert.deepStrictEqual(effective.midfielder, { value: 'left', source: 'default' });
    assert.deepStrictEqual(effective.forward, { value: null, source: 'default' });
  });

  await t.test('resolveEffectivePreferences: a temporary override wins for that role only, never touching others', () => {
    const saved = { defender: 'right', midfielder: 'left', forward: null };
    const effective = sidePrefs.resolveEffectivePreferences(saved, { defender: 'left' });
    assert.deepStrictEqual(effective.defender, { value: 'left', source: 'temporary' });
    assert.deepStrictEqual(effective.midfielder, { value: 'left', source: 'default' });
  });

  await t.test('resolveEffectivePreferences: an explicit "none" override is distinguishable from an omitted role', () => {
    const saved = { defender: 'right', midfielder: 'left', forward: null };
    const effective = sidePrefs.resolveEffectivePreferences(saved, { defender: 'none' });
    assert.deepStrictEqual(effective.defender, { value: null, source: 'temporary' }, 'explicit none must disable it, not inherit');
    assert.deepStrictEqual(effective.midfielder, { value: 'left', source: 'default' }, 'an omitted role must still inherit the saved default');
  });

  await t.test('resolveEffectivePreferences: ignoreAll disables every role not otherwise overridden, without touching saved data', () => {
    const saved = { defender: 'right', midfielder: 'left', forward: null };
    const effective = sidePrefs.resolveEffectivePreferences(saved, {}, { ignoreAll: true });
    assert.deepStrictEqual(effective.defender, { value: null, source: 'temporary' });
    assert.deepStrictEqual(effective.midfielder, { value: null, source: 'temporary' });
    assert.strictEqual(saved.defender, 'right', 'ignoreAll must never mutate the saved preferences object');
  });

  await t.test('applySideAssignment swaps a pair so the lower-average player lands on the preferred side', () => {
    const lineup = [
      { position: 'left_back', role: 'defender', player: playerWith(1, 5), pinKind: null }, // avg 3
      { position: 'right_back', role: 'defender', player: playerWith(5, 4), pinKind: null }, // avg 4.5 (lower)
    ];
    sidePrefs.applySideAssignment('2-3-1', lineup, { defender: { value: 'right', source: 'default' } });
    // lower average (left_back's original occupant, avg 3) should now be on the right.
    assert.strictEqual(lineup[1].player.skills.offense, 1);
    assert.strictEqual(lineup[0].player.skills.offense, 5);
  });

  await t.test('applySideAssignment never moves an exact-pinned player, even against the preference', () => {
    const pinnedPlayer = playerWith(1, 5); // lower average, "wrong" side for this preference
    const otherPlayer = playerWith(5, 4);
    const lineup = [
      { position: 'left_back', role: 'defender', player: pinnedPlayer, pinKind: 'exact' },
      { position: 'right_back', role: 'defender', player: otherPlayer, pinKind: null },
    ];
    sidePrefs.applySideAssignment('2-3-1', lineup, { defender: { value: 'right', source: 'default' } });
    assert.strictEqual(lineup[0].player, pinnedPlayer, 'the exact pin must never move');
    assert.strictEqual(lineup[1].player, otherPlayer);
  });

  await t.test('applySideAssignment leaves equal averages exactly as they were (stable, no swap)', () => {
    const left = playerWith(3, 3);
    const right = playerWith(2, 4); // same average (3), different raw skills
    const lineup = [
      { position: 'left_back', role: 'defender', player: left, pinKind: null },
      { position: 'right_back', role: 'defender', player: right, pinKind: null },
    ];
    sidePrefs.applySideAssignment('2-3-1', lineup, { defender: { value: 'right', source: 'default' } });
    assert.strictEqual(lineup[0].player, left);
    assert.strictEqual(lineup[1].player, right);
  });

  await t.test('applySideAssignment does nothing when there is no preference for that role', () => {
    const left = playerWith(1, 5);
    const right = playerWith(5, 4);
    const lineup = [
      { position: 'left_forward', role: 'forward', player: left, pinKind: null },
      { position: 'right_forward', role: 'forward', player: right, pinKind: null },
    ];
    sidePrefs.applySideAssignment('2-2-2', lineup, { forward: { value: null, source: 'default' } });
    assert.strictEqual(lineup[0].player, left, 'no preference must preserve the scheduler\'s normal ordering');
    assert.strictEqual(lineup[1].player, right);
  });

  await t.test('applySideAssignment ignores the center slot in a three-slot group', () => {
    const left = playerWith(1, 5);
    const center = playerWith(3, 3);
    const right = playerWith(5, 4);
    const lineup = [
      { position: 'left_back', role: 'defender', player: left, pinKind: null },
      { position: 'center_back', role: 'defender', player: center, pinKind: null },
      { position: 'right_back', role: 'defender', player: right, pinKind: null },
    ];
    sidePrefs.applySideAssignment('3-2-1', lineup, { defender: { value: 'right', source: 'default' } });
    assert.strictEqual(lineup[1].player, center, 'the center slot must never be touched by side-assignment');
    // left avg 3, right avg 4.5 -> lower (left's current occupant) should move to the right.
    assert.strictEqual(lineup[1].position, 'center_back');
  });
});
