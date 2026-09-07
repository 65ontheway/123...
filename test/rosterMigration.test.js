const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { migrateLegacyRosters } = require('../lib/rosterMigration');

const TMP_ROOT = path.join(os.tmpdir(), 'raygpt-test-migration-' + process.pid);

// Fictional fixture data only.
const rosterA = {
  formation: '2-3-1',
  players: [{ id: 'p1', name: 'Fixture Alpha', skills: { offense: 3, defense: 3, goalie: 3 } }],
};

// Each subtest gets its own fresh legacy/new directory pair so subtests
// can't interfere with one another regardless of run order.
function setupFixture(name) {
  const legacyDir = path.join(TMP_ROOT, name, 'legacy');
  const newDir = path.join(TMP_ROOT, name, 'new');
  fs.rmSync(path.join(TMP_ROOT, name), { recursive: true, force: true });
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'coachA.json'), JSON.stringify(rosterA));
  fs.writeFileSync(path.join(legacyDir, 'coachB.json'), JSON.stringify({ formation: '2-3-1', players: [] }));
  fs.writeFileSync(path.join(legacyDir, 'corrupt.json'), '{not valid json');
  fs.writeFileSync(path.join(legacyDir, 'wrongshape.json'), JSON.stringify({ notPlayers: [] }));
  return { legacyDir, newDir };
}

test('rosterMigration.js', async (t) => {
  await t.test('no legacy directory at all -> empty summary, no error', () => {
    const newDir = path.join(TMP_ROOT, 'no-legacy-dir', 'new');
    const nonexistentLegacyDir = path.join(TMP_ROOT, 'no-legacy-dir', 'does-not-exist');
    const summary = migrateLegacyRosters(newDir, nonexistentLegacyDir);
    assert.deepStrictEqual(summary, { migrated: [], conflicts: [], skippedInvalid: [], errors: [] });
  });

  await t.test('clean migration copies valid files, skips invalid ones, never touches the original', () => {
    const { legacyDir, newDir } = setupFixture('clean-migration');
    const summary = migrateLegacyRosters(newDir, legacyDir);
    assert.deepStrictEqual(summary.migrated.sort(), ['coachA.json', 'coachB.json']);
    assert.deepStrictEqual(summary.skippedInvalid.sort(), ['corrupt.json', 'wrongshape.json']);
    assert.deepStrictEqual(summary.conflicts, []);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(newDir, 'coachA.json'), 'utf8')), rosterA);
    assert.ok(fs.existsSync(path.join(legacyDir, 'coachA.json')), 'legacy original must still exist');
  });

  await t.test('re-running migration is idempotent', () => {
    const { legacyDir, newDir } = setupFixture('idempotent');
    migrateLegacyRosters(newDir, legacyDir);
    const summary = migrateLegacyRosters(newDir, legacyDir);
    assert.deepStrictEqual(summary.migrated, []);
    assert.deepStrictEqual(summary.conflicts, []);
  });

  await t.test('a genuine conflict is reported, destination is not overwritten, legacy original is untouched', () => {
    const { legacyDir, newDir } = setupFixture('conflict');
    migrateLegacyRosters(newDir, legacyDir);
    fs.writeFileSync(
      path.join(newDir, 'coachA.json'),
      JSON.stringify({ formation: '2-3-1', players: [{ id: 'different', name: 'Fixture Other', skills: { offense: 1, defense: 1, goalie: 1 } }] })
    );
    const summary = migrateLegacyRosters(newDir, legacyDir);
    assert.deepStrictEqual(summary.conflicts, ['coachA.json']);
    const dest = JSON.parse(fs.readFileSync(path.join(newDir, 'coachA.json'), 'utf8'));
    assert.strictEqual(dest.players[0].name, 'Fixture Other', 'conflicting destination must not be silently overwritten');
    const legacy = JSON.parse(fs.readFileSync(path.join(legacyDir, 'coachA.json'), 'utf8'));
    assert.deepStrictEqual(legacy, rosterA, 'legacy original must never be modified');
  });

  t.after(() => {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  });
});
