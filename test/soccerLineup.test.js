const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// RAYGPT_DATA_DIR must be set before soccerLineup.js's lazy getRosterDir()
// is first invoked by any of these tests. It's read lazily (not at
// require time), so setting it here, before any call that touches the
// filesystem, is enough — no module reset needed.
const TMP_ROOT = path.join(os.tmpdir(), 'raygpt-test-soccerLineup-' + process.pid);
process.env.RAYGPT_DATA_DIR = TMP_ROOT;

const soccerLineup = require('../lib/soccerLineup');

test('soccerLineup.js storage layer', async (t) => {
  t.before(() => {
    soccerLineup.initRosterStorage();
  });

  await t.test('a brand-new account has no roster (missing, not an error)', () => {
    assert.strictEqual(soccerLineup.loadRosterResult('fixtureCoachMissing').status, 'missing');
    assert.strictEqual(soccerLineup.loadRoster('fixtureCoachMissing'), null);
  });

  await t.test('save/reload round trip preserves a stable player id', () => {
    const roster = { formation: '2-3-1', players: [] };
    const added = soccerLineup.addPlayerDirect(roster, { name: 'Fixture Alpha', offense: 4, defense: 2, goalie: 1 });
    assert.ok(added.id, 'a newly added player must have an id');
    soccerLineup.saveRoster('fixtureCoachA', roster);
    const reloaded = soccerLineup.loadRoster('fixtureCoachA');
    assert.strictEqual(reloaded.players[0].id, added.id);
  });

  await t.test('a corrupt roster file is reported as invalid, and loadRoster throws rather than returning null', () => {
    const dir = path.join(soccerLineup.getRosterDir());
    fs.writeFileSync(path.join(dir, 'fixtureCoachCorrupt.json'), '{not valid json');
    assert.strictEqual(soccerLineup.loadRosterResult('fixtureCoachCorrupt').status, 'invalid');
    assert.throws(() => soccerLineup.loadRoster('fixtureCoachCorrupt'), /ROSTER_UNREADABLE|could not be read/);
  });

  await t.test('a wrong-shaped roster file (no players array) is also reported as invalid', () => {
    const dir = soccerLineup.getRosterDir();
    fs.writeFileSync(path.join(dir, 'fixtureCoachWrongShape.json'), JSON.stringify({ notPlayers: [] }));
    assert.strictEqual(soccerLineup.loadRosterResult('fixtureCoachWrongShape').status, 'invalid');
  });

  await t.test('a failed save leaves the previous roster file completely untouched', () => {
    const roster = { formation: '2-3-1', players: [] };
    soccerLineup.addPlayerDirect(roster, { name: 'Fixture Bravo', offense: 3, defense: 3, goalie: 3 });
    soccerLineup.saveRoster('fixtureCoachFailSave', roster);
    const rosterFile = path.join(soccerLineup.getRosterDir(), 'fixtureCoachFailSave.json');
    const before = fs.readFileSync(rosterFile, 'utf8');

    // Force the write to fail regardless of root/permissions: shadow the
    // roster directory itself with a plain file so no write inside it can
    // succeed.
    const dir = path.dirname(rosterFile);
    fs.renameSync(dir, dir + '-swap');
    fs.writeFileSync(dir, 'blocked');
    let threw = false;
    try {
      soccerLineup.saveRoster('fixtureCoachFailSave', {
        formation: '2-3-1',
        players: [{ id: 'x', name: 'Should Not Persist', skills: { offense: 1, defense: 1, goalie: 1 } }],
      });
    } catch {
      threw = true;
    } finally {
      fs.unlinkSync(dir);
      fs.renameSync(dir + '-swap', dir);
    }
    assert.ok(threw, 'a save that cannot complete must throw');
    assert.strictEqual(fs.readFileSync(rosterFile, 'utf8'), before, 'the previous roster file must be byte-for-byte unchanged');
  });

  await t.test('concurrent updates via withRosterLock never lose a write', async () => {
    soccerLineup.saveRoster('fixtureCoachConcurrent', { formation: '2-3-1', players: [] });
    await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        soccerLineup.withRosterLock('fixtureCoachConcurrent', async () => {
          const current = soccerLineup.loadRoster('fixtureCoachConcurrent');
          await new Promise((r) => setTimeout(r, 5));
          soccerLineup.addPlayerDirect(current, { name: `Fixture Player ${n}` });
          soccerLineup.saveRoster('fixtureCoachConcurrent', current);
        })
      )
    );
    const final = soccerLineup.loadRoster('fixtureCoachConcurrent');
    assert.strictEqual(final.players.length, 5, `expected all 5 concurrent adds to survive, got ${final.players.length}`);
  });

  await t.test('two accounts never see each other\'s roster data', () => {
    soccerLineup.saveRoster('fixtureCoachIsoA', {
      formation: '2-3-1',
      players: [{ id: 'a', name: 'Fixture Iso A', skills: { offense: 1, defense: 1, goalie: 1 } }],
    });
    soccerLineup.saveRoster('fixtureCoachIsoB', {
      formation: '2-3-1',
      players: [{ id: 'b', name: 'Fixture Iso B', skills: { offense: 1, defense: 1, goalie: 1 } }],
    });
    const a = soccerLineup.loadRoster('fixtureCoachIsoA');
    const b = soccerLineup.loadRoster('fixtureCoachIsoB');
    assert.strictEqual(a.players[0].name, 'Fixture Iso A');
    assert.strictEqual(b.players[0].name, 'Fixture Iso B');
    assert.strictEqual(a.players.length, 1);
    assert.strictEqual(b.players.length, 1);
  });

  await t.test('duplicate player names resolve correctly by id, never by name, in scheduling', () => {
    const roster = { formation: '2-3-1', players: [] };
    const samA = soccerLineup.addPlayerDirect(roster, { name: 'Fixture Sam', offense: 5, defense: 1, goalie: 1 });
    const samB = soccerLineup.addPlayerDirect(roster, { name: 'Fixture Sam', offense: 1, defense: 5, goalie: 1 });
    for (let i = 0; i < 6; i++) soccerLineup.addPlayerDirect(roster, { name: `Fixture Filler ${i}` });

    const result = soccerLineup.computeGameLineup(roster, { resting: { 1: [samB.id] } });
    const q1PlayerIds = result.quarters[0].lineup.filter((s) => s.player).map((s) => s.player.id);
    assert.ok(q1PlayerIds.includes(samA.id), 'the non-resting duplicate-named player should be playing');
    assert.ok(!q1PlayerIds.includes(samB.id), 'the resting duplicate-named player should not be playing');

    const pinResult = soccerLineup.computeGameLineup(roster, { pinned: { 2: { [samA.id]: 'forward' } } });
    const forwardSlot = pinResult.quarters[1].lineup.find((s) => s.position === 'forward');
    assert.strictEqual(forwardSlot.player.id, samA.id, 'the specific pinned duplicate-named player must get the slot');
  });

  await t.test('validation rejects an empty player name', () => {
    const roster = { formation: '2-3-1', players: [] };
    assert.throws(() => soccerLineup.addPlayerDirect(roster, { name: '' }), soccerLineup.RosterValidationError);
    assert.throws(() => soccerLineup.addPlayerDirect(roster, {}), soccerLineup.RosterValidationError);
  });

  await t.test('updatePlayerDirect/removePlayerDirect operate by id, unaffected by duplicate names', () => {
    const roster = { formation: '2-3-1', players: [] };
    const p1 = soccerLineup.addPlayerDirect(roster, { name: 'Fixture Dup' });
    const p2 = soccerLineup.addPlayerDirect(roster, { name: 'Fixture Dup' });
    soccerLineup.updatePlayerDirect(roster, p1.id, { offense: 5 });
    assert.strictEqual(soccerLineup.findPlayerById(roster.players, p1.id).skills.offense, 5);
    assert.notStrictEqual(soccerLineup.findPlayerById(roster.players, p2.id).skills.offense, 5);
    const removed = soccerLineup.removePlayerDirect(roster, p2.id);
    assert.strictEqual(removed.id, p2.id);
    assert.strictEqual(roster.players.length, 1);
    assert.strictEqual(roster.players[0].id, p1.id);
  });

  t.after(() => {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  });
});
