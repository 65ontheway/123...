// Focused coverage for the two new lib/soccerRosterRoutes.js endpoints,
// /roster/export and /roster/import (the roster-panel backup feature) —
// added after a real production incident where a broken deployment wiped
// the only copy of a coach's roster with no way to recover it. Route
// handlers are called directly (bypassing requireAuth), same pattern
// test/soccerApiValidation.test.js uses for this file's sibling module.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

process.env.RAYGPT_DATA_DIR = path.join(os.tmpdir(), 'raygpt-test-roster-routes-' + process.pid);

const soccerLineup = require('../lib/soccerLineup');
const router = require('../lib/soccerRosterRoutes');

function seedRoster(username, formation = '2-3-1') {
  const roster = { formation, players: [] };
  soccerLineup.addPlayerDirect(roster, { name: 'Fixture Nova', offense: 3, defense: 4, goalie: 1 });
  soccerLineup.addPlayerDirect(roster, { name: 'Fixture Orion', offense: 2, defense: 2, goalie: 5 });
  soccerLineup.saveRoster(username, roster);
  return { roster: soccerLineup.loadRoster(username) };
}

function findHandler(method, routePath) {
  const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  return layer.route.stack.at(-1).handle; // last middleware in the chain is the actual handler (requireAuth is earlier)
}

function makeRes() {
  const state = { statusCode: 200, jsonBody: null, body: undefined, headers: {} };
  return {
    status(code) {
      state.statusCode = code;
      return this;
    },
    json(obj) {
      state.jsonBody = obj;
      return this;
    },
    send(body) {
      state.body = body;
      return this;
    },
    setHeader(key, value) {
      state.headers[key] = value;
    },
    get statusCode() {
      return state.statusCode;
    },
    get jsonBody() {
      return state.jsonBody;
    },
    get body() {
      return state.body;
    },
    get headers() {
      return state.headers;
    },
  };
}

const exportHandler = findHandler('get', '/roster/export');
const importHandler = findHandler('post', '/roster/import');

test('soccerRosterRoutes.js: /roster/export and /roster/import', async (t) => {
  t.before(() => {
    soccerLineup.initRosterStorage();
  });

  await t.test('export sends the roster as a downloadable JSON file, in the nested-skills storage shape', async () => {
    const { roster } = seedRoster('rrCoachExport');
    const res = makeRes();
    await exportHandler({ session: { username: 'rrCoachExport' } }, res);
    assert.ok(res.headers['Content-Disposition']?.includes('attachment'), 'must be offered as a download, not inline JSON');
    assert.ok(res.headers['Content-Disposition']?.includes('.json'));
    const parsed = JSON.parse(res.body);
    assert.strictEqual(parsed.players.length, roster.players.length);
    assert.strictEqual(parsed.players[0].name, 'Fixture Nova');
    assert.strictEqual(parsed.players[0].skills.offense, 3, 'exported shape nests ratings under skills, matching storage');
  });

  await t.test('import replaces the roster wholesale and never trusts a client-supplied id', async () => {
    seedRoster('rrCoachImport'); // an existing roster the import must fully replace, not merge into
    const res = makeRes();
    await importHandler(
      {
        session: { username: 'rrCoachImport' },
        body: { formation: '3-1-2', players: [{ id: 'attacker-supplied-id', name: 'Restored Nova', skills: { offense: 2, defense: 2, goalie: 2 } }] },
      },
      res
    );
    assert.strictEqual(res.jsonBody.ok, true);
    assert.strictEqual(res.jsonBody.roster.players.length, 1, 'the prior roster\'s players must be gone, not merged with');
    assert.strictEqual(res.jsonBody.roster.players[0].name, 'Restored Nova');
    assert.notStrictEqual(res.jsonBody.roster.players[0].id, 'attacker-supplied-id');
    assert.strictEqual(res.jsonBody.roster.formation, '3-1-2');
  });

  await t.test('import falls back to the default formation for an unrecognized one, without losing any players over it', async () => {
    const res = makeRes();
    await importHandler(
      {
        session: { username: 'rrCoachImportBadFormation' },
        body: { formation: 'not-a-real-formation', players: [{ name: 'Fixture Solo', skills: { offense: 1, defense: 1, goalie: 1 } }] },
      },
      res
    );
    assert.strictEqual(res.jsonBody.ok, true);
    assert.strictEqual(res.jsonBody.roster.formation, soccerLineup.DEFAULT_FORMATION);
    assert.strictEqual(res.jsonBody.roster.players.length, 1);
  });

  await t.test('import rejects a shape that is not a recognized roster backup, without touching the saved roster', async () => {
    const { roster: before } = seedRoster('rrCoachImportBad');
    const res = makeRes();
    await importHandler({ session: { username: 'rrCoachImportBad' }, body: { players: [{ name: 'Missing skills' }] } }, res);
    assert.strictEqual(res.statusCode, 400);
    const after = soccerLineup.loadRoster('rrCoachImportBad');
    assert.deepStrictEqual(after, before, 'a rejected import must never partially apply');
  });

  await t.test('a downloaded export, re-uploaded, restores the same players (round-trip)', async () => {
    const { roster: seeded } = seedRoster('rrCoachRoundtrip');
    const exportRes = makeRes();
    await exportHandler({ session: { username: 'rrCoachRoundtrip' } }, exportRes);
    const exported = JSON.parse(exportRes.body);

    const importRes = makeRes();
    await importHandler({ session: { username: 'rrCoachRoundtrip' }, body: exported }, importRes);
    assert.strictEqual(importRes.jsonBody.ok, true);
    assert.deepStrictEqual(
      importRes.jsonBody.roster.players.map((p) => p.name).sort(),
      seeded.players.map((p) => p.name).sort()
    );
    assert.strictEqual(importRes.jsonBody.roster.formation, seeded.formation);
  });

  await t.test('export for an account with no roster yet returns an empty roster, not an error', async () => {
    const res = makeRes();
    await exportHandler({ session: { username: 'rrCoachNeverSaved' } }, res);
    const parsed = JSON.parse(res.body);
    assert.deepStrictEqual(parsed.players, []);
  });
});
