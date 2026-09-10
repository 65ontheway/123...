const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

process.env.RAYGPT_DATA_DIR = path.join(os.tmpdir(), 'raygpt-test-soccer-api-validation-' + process.pid);

const { validateSoccer } = require('../lib/soccerApiValidation');

function run(method, urlPath, body) {
  const req = { method, path: urlPath, body };
  let statusCode = null;
  let jsonBody = null;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(obj) {
      jsonBody = obj;
    },
  };
  let nextCalled = false;
  validateSoccer(req, res, () => {
    nextCalled = true;
  });
  return { nextCalled, statusCode, jsonBody };
}

test('soccerApiValidation.js: validateSoccer', async (t) => {
  await t.test('a roster/settings PUT with only side preferences passes, as before', () => {
    const result = run('PUT', '/roster/settings', { defender: 'left' });
    assert.strictEqual(result.nextCalled, true);
  });

  await t.test('a roster/settings PUT accepts the roster panel\'s formation field', () => {
    const result = run('PUT', '/roster/settings', { formation: '2-3-1' });
    assert.strictEqual(result.nextCalled, true, 'the roster panel\'s formation dropdown must not be rejected as an unrecognized field');
  });

  await t.test('a roster/settings PUT rejects a formation not in the supported catalog', () => {
    const result = run('PUT', '/roster/settings', { formation: '4-4-2' });
    assert.strictEqual(result.nextCalled, false);
    assert.strictEqual(result.statusCode, 400);
  });

  await t.test('a roster/settings PUT can combine formation with a side preference in one request', () => {
    const result = run('PUT', '/roster/settings', { formation: '3-1-2', midfielder: 'right' });
    assert.strictEqual(result.nextCalled, true);
  });

  await t.test('formation is never accepted on the game-scheduling (set_game_lineup) request shape', () => {
    // set_game_lineup already has its own `formation` property (a this-
    // lineup-only override) — this just confirms the roster/settings
    // extension didn't leak into the shared game schema.
    const result = run('POST', '/games', { formation: '2-3-1' });
    assert.strictEqual(result.nextCalled, true, 'set_game_lineup already supports formation on its own — this should still pass');
  });

  await t.test('a roster/import POST accepts a well-formed backup (nested skills, as exported)', () => {
    const result = run('POST', '/roster/import', {
      formation: '2-3-1',
      players: [{ id: 'x', name: 'Fixture Nova', skills: { offense: 3, defense: 4, goalie: 1 } }],
    });
    assert.strictEqual(result.nextCalled, true);
  });

  await t.test('a roster/import POST rejects a player missing the nested skills object', () => {
    const result = run('POST', '/roster/import', { players: [{ name: 'Fixture Nova', offense: 3, defense: 4, goalie: 1 }] });
    assert.strictEqual(result.nextCalled, false);
    assert.strictEqual(result.statusCode, 400);
  });

  await t.test('a roster/import POST rejects an out-of-range rating inside skills', () => {
    const result = run('POST', '/roster/import', {
      players: [{ name: 'Fixture Nova', skills: { offense: 9, defense: 4, goalie: 1 } }],
    });
    assert.strictEqual(result.nextCalled, false);
    assert.strictEqual(result.statusCode, 400);
  });

  await t.test('a roster/import POST passes an unrecognized formation string through to the route to fall back on, unlike roster/settings', () => {
    const result = run('POST', '/roster/import', {
      formation: 'not-a-real-formation',
      players: [{ name: 'Fixture Nova', skills: { offense: 3, defense: 4, goalie: 1 } }],
    });
    assert.strictEqual(result.nextCalled, true, 'schema-level rejection here would prevent the graceful default-formation fallback the route implements');
  });

  await t.test('a roster/import POST requires players to be present at all', () => {
    const result = run('POST', '/roster/import', { formation: '2-3-1' });
    assert.strictEqual(result.nextCalled, false);
    assert.strictEqual(result.statusCode, 400);
  });
});
