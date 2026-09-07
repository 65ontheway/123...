const test = require('node:test');
const assert = require('node:assert/strict');

const formations = require('../lib/soccerFormations');

test('soccerFormations.js', async (t) => {
  await t.test('every formation has exactly 7 unique slots, goalkeeper first', () => {
    for (const [name, slots] of Object.entries(formations.FORMATIONS)) {
      assert.strictEqual(slots.length, 7, `${name} should have 7 slots`);
      assert.strictEqual(new Set(slots).size, 7, `${name}'s slots should all be unique`);
      assert.strictEqual(slots[0], 'goalkeeper', `${name}'s first slot should be goalkeeper`);
      for (const id of slots) {
        assert.ok(formations.POSITION_CATALOG[id], `${name} references unknown position "${id}"`);
      }
    }
  });

  await t.test('role suitability scoring is unchanged: goalie/defense/offense per role, midfielder is the average', () => {
    const player = { skills: { offense: 4, defense: 2, goalie: 5 } };
    assert.strictEqual(formations.positionSkill(player, 'goalkeeper'), 5);
    assert.strictEqual(formations.positionSkill(player, 'defender'), 2);
    assert.strictEqual(formations.positionSkill(player, 'forward'), 4);
    assert.strictEqual(formations.positionSkill(player, 'midfielder'), 3);
  });

  await t.test('resolveFormationName prefers the request, then the roster default, then 2-3-1', () => {
    assert.strictEqual(formations.resolveFormationName('3-2-1', '2-2-2'), '3-2-1');
    assert.strictEqual(formations.resolveFormationName(null, '2-2-2'), '2-2-2');
    assert.strictEqual(formations.resolveFormationName(null, null), '2-3-1');
    assert.strictEqual(formations.resolveFormationName('not-a-formation', '2-2-2'), '2-2-2');
  });

  await t.test('normalizePositionToken recognizes exact ids, aliases, roles, and role aliases', () => {
    assert.deepStrictEqual(formations.normalizePositionToken('left_back'), { kind: 'exact', id: 'left_back' });
    assert.deepStrictEqual(formations.normalizePositionToken('left back'), { kind: 'exact', id: 'left_back' });
    assert.deepStrictEqual(formations.normalizePositionToken('goalie'), { kind: 'exact', id: 'goalkeeper' });
    assert.deepStrictEqual(formations.normalizePositionToken('Center Midfield'), { kind: 'exact', id: 'center_mid' });
    assert.deepStrictEqual(formations.normalizePositionToken('defender'), { kind: 'role', role: 'defender' });
    assert.deepStrictEqual(formations.normalizePositionToken('defense'), { kind: 'role', role: 'defender' });
    assert.deepStrictEqual(formations.normalizePositionToken('midfield'), { kind: 'role', role: 'midfielder' });
    assert.strictEqual(formations.normalizePositionToken('shortstop'), null);
    assert.strictEqual(formations.normalizePositionToken(''), null);
  });

  await t.test('isExactPositionValidForFormation catches a position that exists in one formation but not another', () => {
    assert.strictEqual(formations.isExactPositionValidForFormation('2-3-1', 'left_wing'), true);
    assert.strictEqual(formations.isExactPositionValidForFormation('3-2-1', 'left_wing'), false);
    assert.strictEqual(formations.isExactPositionValidForFormation('3-2-1', 'center_back'), true);
    assert.strictEqual(formations.isExactPositionValidForFormation('2-3-1', 'center_back'), false);
  });

  await t.test('getSidePairGroups: 2-3-1 has defender and midfielder pairs, forward is a lone center slot', () => {
    const groups = formations.getSidePairGroups('2-3-1');
    const defender = groups.find((g) => g.role === 'defender');
    const midfielder = groups.find((g) => g.role === 'midfielder');
    const forward = groups.find((g) => g.role === 'forward');
    assert.deepStrictEqual(defender, { role: 'defender', left: 'left_back', right: 'right_back', center: null });
    assert.deepStrictEqual(midfielder, { role: 'midfielder', left: 'left_wing', right: 'right_wing', center: 'center_mid' });
    assert.strictEqual(forward, undefined, 'a lone striker with no side has no pair group at all');
  });

  await t.test('getSidePairGroups: 3-2-1 defender is a three-slot group with only left/right comparable', () => {
    const groups = formations.getSidePairGroups('3-2-1');
    const defender = groups.find((g) => g.role === 'defender');
    assert.deepStrictEqual(defender, { role: 'defender', left: 'left_back', right: 'right_back', center: 'center_back' });
  });

  await t.test('getSidePairGroups: 3-1-2 center_mid is a lone center slot (no midfielder pair), forwards do pair', () => {
    const groups = formations.getSidePairGroups('3-1-2');
    const midfielder = groups.find((g) => g.role === 'midfielder');
    const forward = groups.find((g) => g.role === 'forward');
    assert.deepStrictEqual(midfielder, { role: 'midfielder', left: null, right: null, center: 'center_mid' });
    assert.deepStrictEqual(forward, { role: 'forward', left: 'left_forward', right: 'right_forward', center: null });
  });
});
