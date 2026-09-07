const test = require('node:test');
const assert = require('node:assert/strict');
const { CONTINUITY_ROLES, applyPositionContinuity } = require('../lib/soccerPositionContinuity');

function playerWith(id) {
  return { id, name: `Fixture ${id}`, skills: { offense: 3, defense: 3, goalie: 1 } };
}

function slot(position, role, player, pinKind = null) {
  return { position, role, player, pinKind };
}

test('soccerPositionContinuity.js', async (t) => {
  await t.test('CONTINUITY_ROLES covers exactly defender and midfielder', () => {
    assert.deepStrictEqual([...CONTINUITY_ROLES].sort(), ['defender', 'midfielder']);
  });

  await t.test('no previous quarter (Q1): the lineup is left completely untouched', () => {
    const a = playerWith('a');
    const lineup = [slot('left_back', 'defender', a)];
    applyPositionContinuity(lineup, null);
    assert.strictEqual(lineup[0].player, a);
  });

  await t.test('two quarters in a row on defense: a scramble within defense is restored to last quarter\'s exact positions', () => {
    const a = playerWith('a');
    const b = playerWith('b');
    const previous = [slot('left_back', 'defender', a), slot('right_back', 'defender', b)];
    // This quarter's automatic fill scrambled them the other way around
    // (both still playing defender — just a different side each).
    const lineup = [slot('left_back', 'defender', b), slot('right_back', 'defender', a)];
    applyPositionContinuity(lineup, previous);
    assert.strictEqual(lineup[0].player, a, 'left_back should be restored to its previous occupant');
    assert.strictEqual(lineup[1].player, b, 'right_back should be restored to its previous occupant');
  });

  await t.test('two quarters in a row at midfield: a scramble within midfield is restored to last quarter\'s exact positions', () => {
    const a = playerWith('a');
    const b = playerWith('b');
    const previous = [slot('left_wing', 'midfielder', a), slot('right_wing', 'midfielder', b)];
    const lineup = [slot('left_wing', 'midfielder', b), slot('right_wing', 'midfielder', a)];
    applyPositionContinuity(lineup, previous);
    assert.strictEqual(lineup[0].player, a);
    assert.strictEqual(lineup[1].player, b);
  });

  await t.test('a ROLE CHANGE between quarters is never corrected — continuity only applies to the SAME role two quarters in a row', () => {
    const a = playerWith('a'); // played center_mid (midfielder) last quarter
    const b = playerWith('b'); // played left_back (defender) last quarter
    const previous = [slot('center_mid', 'midfielder', a), slot('left_back', 'defender', b)];
    // This quarter, the automatic fill swapped their ROLES entirely: A is now
    // a defender, B is now a midfielder. Continuity must leave this alone —
    // it never second-guesses a role change, only a same-role reshuffle.
    const lineup = [slot('left_back', 'defender', a), slot('center_mid', 'midfielder', b)];
    applyPositionContinuity(lineup, previous);
    assert.strictEqual(lineup[0].player, a, 'a role change is outside continuity\'s scope — must not be pulled back across roles');
    assert.strictEqual(lineup[1].player, b);
  });

  await t.test('an exact-pinned slot is never moved, and never used as someone else\'s continuity target', () => {
    const a = playerWith('a'); // wants left_back back
    const pinned = playerWith('pinned'); // explicitly pinned to left_back THIS quarter
    const previous = [slot('left_back', 'defender', a), slot('right_back', 'defender', pinned)];
    const lineup = [slot('left_back', 'defender', pinned, 'exact'), slot('right_back', 'defender', a)];
    applyPositionContinuity(lineup, previous);
    assert.strictEqual(lineup[0].player, pinned, 'the exact pin must never be displaced');
    assert.strictEqual(lineup[1].player, a, 'with no reachable target, the continuing player just stays where the fill put them');
  });

  await t.test('a generic-pinned slot is also excluded from continuity, in both directions', () => {
    const a = playerWith('a'); // wants left_back back
    const pinnedForRole = playerWith('pinnedForRole'); // generically pinned to "defender" this quarter, landed at left_back
    const previous = [slot('left_back', 'defender', a), slot('right_back', 'defender', pinnedForRole)];
    const lineup = [slot('left_back', 'defender', pinnedForRole, 'generic'), slot('right_back', 'defender', a)];
    applyPositionContinuity(lineup, previous);
    assert.strictEqual(lineup[0].player, pinnedForRole, 'a generic pin for this quarter must never be displaced by continuity');
    assert.strictEqual(lineup[1].player, a);
  });

  await t.test('a brand-new player (no defender/midfielder history last quarter) is never moved by continuity', () => {
    const newSub = playerWith('newSub');
    const previous = [slot('left_back', 'defender', playerWith('someoneElse'))];
    const lineup = [slot('left_back', 'defender', newSub)];
    applyPositionContinuity(lineup, previous);
    assert.strictEqual(lineup[0].player, newSub, 'no history means no continuity claim on this slot');
  });

  await t.test('a player who rested or was benched last quarter (absent from the previous lineup) has no continuity constraint', () => {
    const benched = playerWith('benched');
    const previous = [slot('left_back', 'defender', playerWith('other'))]; // benched player doesn't appear at all
    const lineup = [slot('right_back', 'defender', benched)];
    applyPositionContinuity(lineup, previous);
    assert.strictEqual(lineup[0].player, benched, 'no prior D/M position on record means nothing to restore — not "two quarters in a row"');
  });

  await t.test('a three-way cycle within the same role (midfield) fully resolves', () => {
    const a = playerWith('a');
    const b = playerWith('b');
    const c = playerWith('c');
    const previous = [
      slot('left_wing', 'midfielder', a),
      slot('center_mid', 'midfielder', b),
      slot('right_wing', 'midfielder', c),
    ];
    // A cyclic scramble within midfield: a->center_mid's spot, b->right_wing's spot, c->left_wing's spot.
    const lineup = [
      slot('left_wing', 'midfielder', c),
      slot('center_mid', 'midfielder', a),
      slot('right_wing', 'midfielder', b),
    ];
    applyPositionContinuity(lineup, previous);
    assert.strictEqual(lineup[0].player, a);
    assert.strictEqual(lineup[1].player, b);
    assert.strictEqual(lineup[2].player, c);
  });

  await t.test('forward/goalkeeper slots are never part of continuity, even for a player who played defense last quarter', () => {
    const a = playerWith('a'); // played left_back last quarter, moved to forward this quarter
    const previous = [slot('left_back', 'defender', a)];
    const lineup = [slot('striker', 'forward', a), slot('left_back', 'defender', playerWith('b'))];
    applyPositionContinuity(lineup, previous);
    assert.strictEqual(lineup[0].player, a, 'a role change into forward is outside continuity\'s scope entirely');
    assert.strictEqual(lineup[1].player.id, 'b');
  });

  await t.test('a player already in their previous exact position is left alone (no-op, not even an internal swap)', () => {
    const a = playerWith('a');
    const b = playerWith('b');
    const previous = [slot('left_back', 'defender', a), slot('right_back', 'defender', b)];
    const lineup = [slot('left_back', 'defender', a), slot('right_back', 'defender', b)];
    applyPositionContinuity(lineup, previous);
    assert.strictEqual(lineup[0].player, a);
    assert.strictEqual(lineup[1].player, b);
  });
});
