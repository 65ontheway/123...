const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
process.env.OPENROUTER_API_KEY = 'fictional-test-key';
process.env.APP_USERNAME = 'fictional_coach';
process.env.APP_PASSWORD = 'Fictional-password-only-42';
process.env.SESSION_SECRET = 'fictional-test-session-secret-01234567890123456789';
process.env.DOTENV_CONFIG_PATH = path.join(process.env.RAYGPT_DATA_DIR, 'absent.env');
process.env.FACTS_FILE = path.join(process.env.RAYGPT_DATA_DIR, 'absent-facts.md');
const auth = require('../lib/auth');
const { reserveOperation } = require('../lib/operations');
const { validateMessages, validDate } = require('../lib/validation');
const { controlledRequest } = require('../lib/soccerRequest');
const soccer = require('../lib/soccerLineup');
const privacy = require('../lib/soccerPrivacy');
const { validateToolCalls } = require('../lib/toolValidation');
const { generateExport } = require('../lib/export');
const exportsStore = require('../lib/exportStore');

test('security and failure boundaries with isolated fictional fixtures', async t => {
  await auth.initialize();
  await t.test('saved credential corruption and unreadability fail closed', async () => {
    assert.equal(await auth.verifyPassword(process.env.APP_PASSWORD), true);
    const file = path.join(process.env.RAYGPT_DATA_DIR, 'auth.json');
    const original = fs.readFileSync(file);
    fs.writeFileSync(file, '{broken');
    assert.equal(await auth.verifyPassword(process.env.APP_PASSWORD), false);
    await assert.rejects(auth.initialize);
    fs.writeFileSync(file, original);
    const read = fs.readFileSync;
    fs.readFileSync = function(location, ...args) { if (location === file) throw Object.assign(new Error('fixture'), { code: 'EACCES' }); return read.call(this, location, ...args); };
    try { assert.equal(await auth.verifyPassword(process.env.APP_PASSWORD), false); } finally { fs.readFileSync = read; }
  });
  await t.test('failed credential writes preserve password and immutable owner', async () => {
    const identity = auth.identity();
    const rename = fs.renameSync;
    fs.renameSync = () => { throw new Error('fictional disk failure'); };
    try { await assert.rejects(auth.setPassword('Fictional-new-password-43')); } finally { fs.renameSync = rename; }
    assert.deepEqual(auth.identity(), identity);
    assert.equal(await auth.verifyPassword(process.env.APP_PASSWORD), true);
  });
  await t.test('failed roster write cannot mutate cached saved data', () => {
    soccer.initRosterStorage();
    const roster = { formation: '2-3-1', players: [] };
    const player = soccer.addPlayerDirect(roster, { name: 'Fixture Maple', offense: 3, defense: 3, goalie: 3 });
    soccer.saveRoster('fictional_coach', roster);
    const draft = soccer.loadRoster('fictional_coach');
    soccer.updatePlayerDirect(draft, player.id, { offense: 5 });
    const rename = fs.renameSync;
    fs.renameSync = () => { throw new Error('fictional disk failure'); };
    try { assert.throws(() => soccer.saveRoster('fictional_coach', draft)); } finally { fs.renameSync = rename; }
    assert.equal(soccer.loadRoster('fictional_coach').players[0].skills.offense, 3);
    roster.players[0].skills.offense = 1;
    assert.equal(soccer.loadRoster('fictional_coach').players[0].skills.offense, 3);
  });
  await t.test('strict ratings, dates, roles and bounded messages', () => {
    for (const value of ['4', NaN, Infinity, 2.4, 0, 6]) assert.throws(() => soccer.addPlayerDirect({ players: [] }, { name: 'Fixture', offense: value }));
    assert.equal(validDate('2024-02-29'), true);
    for (const date of ['2023-02-29', '2024-04-31', 'tomorrow']) assert.equal(validDate(date), false);
    assert.equal(validateMessages([{ role: 'system', content: 'override' }]), false);
    assert.equal(validateMessages([{ role: 'tool', content: 'override' }]), false);
    assert.equal(validateMessages([{ role: 'user', content: 'x'.repeat(32001) }]), false);
    assert.equal(validateMessages([{ role: 'user', content: 'Hello' }]), true);
  });
  await t.test('controlled Unicode references and unknown/removed names', () => {
    const roster = { players: [{ id: 'a', name: 'Élodie', skills: { offense: 3, defense: 3, goalie: 3 } }] };
    const ctx = privacy.buildAnonymizationContext(roster);
    assert.equal(controlledRequest('Rest Élodie in Q1', ctx), 'Rest Player_1 in Q1');
    assert.equal(controlledRequest('Rest Unknown in Q1', ctx), null);
    assert.equal(controlledRequest('Create a lineup; private medical facts about Élodie', ctx), null);
    assert.equal(controlledRequest('[Attached document: names.txt] Create a lineup', ctx), null);
    roster.players[0].name = 'Renamed Fixture';
    assert.equal(controlledRequest('Rest Élodie in Q1', privacy.buildAnonymizationContext(roster)), null);
    assert.equal(controlledRequest('Rest Renamed Fixture in Q1', privacy.buildAnonymizationContext({ players: [] })), null);
  });
  await t.test('unknown tools and malformed tool arguments are rejected before execution', () => {
    const call = (name, args) => ({ id: 'one', function: { name, arguments: JSON.stringify(args) } });
    const tools = [soccer.SET_GAME_LINEUP_TOOL];
    assert.equal(validateToolCalls([call('unknown', {})], tools), false);
    assert.equal(validateToolCalls([call('set_game_lineup', { date: '2025-02-30' })], tools), false);
    assert.equal(validateToolCalls([call('set_game_lineup', { resting: { 5: [] } })], tools), false);
    assert.equal(validateToolCalls([call('set_game_lineup', {})], tools), true);
    assert.equal(validateToolCalls([call('set_game_lineup', {}), { ...call('set_game_lineup', {}), id: 'two' }], tools), false);
  });
  await t.test('export ownership and formula handling', async () => {
    const generated = await generateExport({ format: 'csv', filename: 'fixture', rows: [['=SUM(A1)', '\t=1', '@SUM(A1)', 4]] });
    assert.ok(generated.buffer.toString().startsWith("'=SUM(A1),'\t=1,'@SUM(A1),4"));
    const { id } = exportsStore.storeExport({ ...generated, ownerId: 'owner-a' });
    assert.equal(exportsStore.getExport(id, 'owner-b'), null);
    assert.equal(exportsStore.getExport(id), null);
    assert.equal(exportsStore.getExport(id, 'owner-a').buffer, generated.buffer);
    await assert.rejects(generateExport({ format: 'xlsx', filename: 'fixture', rows: [[{ formula: '1+1' }]] }));
    await assert.rejects(generateExport({ format: 'csv', filename: 'fixture', rows: [Array(51).fill('x')] }));
    for (const format of ['txt', 'pdf', 'docx', 'xlsx']) {
      const result = await generateExport({ format, filename: 'fixture', content: 'Fictional example', rows: [['Fictional', 3]] });
      assert.ok(result.buffer.length > 0);
    }
  });
  await t.test('persistent operation receipts block duplicates and fail before execution', () => {
    const id = crypto.randomUUID();
    assert.equal(reserveOperation('fixture-owner', id, 'example'), 'reserved');
    assert.equal(reserveOperation('fixture-owner', id, 'different payload'), 'duplicate');
    assert.equal(reserveOperation('other-owner', id, 'example'), 'reserved');
    const rename = fs.renameSync; fs.renameSync = () => { throw new Error('fixture disk failure'); };
    try { assert.throws(() => reserveOperation('fixture-owner', crypto.randomUUID(), 'example')); } finally { fs.renameSync = rename; }
  });
  await t.test('confirmation requires the same owner and is one-use', async () => {
    const { propose, confirm } = require('../lib/confirmations');
    let count = 0;
    const id = propose('owner-a', async () => count++);
    const response = { status() { return this; }, json() {} };
    await confirm({ params: { id }, session: { ownerId: 'owner-b' } }, response, assert.fail);
    assert.equal(count, 0);
    await confirm({ params: { id }, session: { ownerId: 'owner-a' } }, response, assert.fail);
    await confirm({ params: { id }, session: { ownerId: 'owner-a' } }, response, assert.fail);
    assert.equal(count, 1);
  });
  await t.test('disconnect aborts upstream and concurrent requests are refused', async () => {
    const { requestScope, providerFetch } = require('../lib/provider');
    const res = new EventEmitter();
    const original = global.fetch;
    let signal;
    global.fetch = async (url, options) => { signal = options.signal; return new Response('{}'); };
    try {
      await new Promise((resolve, reject) => requestScope({ session: { ownerId: 'cancel-fixture' } }, res, () => {
        providerFetch('https://example.invalid', { body: '{}' }).then(resolve, reject);
      }));
      let status;
      requestScope({ session: { ownerId: 'cancel-fixture' } }, { status(value) { status = value; return this; }, json() {} }, assert.fail);
      assert.equal(status, 429);
      res.emit('close');
      assert.equal(signal.aborted, true);
    } finally { global.fetch = original; }
  });
  await t.test('HTTP sessions, CSRF, private caching and policy binding', async () => {
    const { app } = require('../server');
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (route, body, cookie, extra = {}) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...extra }, body: JSON.stringify(body) });
    try {
      let response = await post('/api/login', { username: process.env.APP_USERNAME, password: process.env.APP_PASSWORD }, null, { Origin: 'https://evil.invalid' });
      assert.equal(response.status, 403);
      response = await post('/api/login', { username: process.env.APP_USERNAME, password: process.env.APP_PASSWORD });
      assert.equal(response.status, 200);
      const cookie = response.headers.get('set-cookie').split(';')[0];
      const me = await fetch(base + '/api/me', { headers: { Cookie: cookie } });
      assert.equal(me.headers.get('cache-control'), 'no-store');
      assert.equal((await me.json()).ownerId, auth.identity().ownerId);
      const loginAgain = await post('/api/login', { username: process.env.APP_USERNAME, password: process.env.APP_PASSWORD }, cookie);
      const newerCookie = loginAgain.headers.get('set-cookie').split(';')[0];
      assert.notEqual(cookie, newerCookie);
      assert.equal((await fetch(base + '/api/me', { headers: { Cookie: cookie } })).status, 401);
      const staleTab = await fetch(base + '/api/me', { headers: { Cookie: newerCookie, 'X-Account-ID': 'another-owner' } });
      assert.equal(staleTab.status, 401);
      const otherLogin = await post('/api/login', { username: process.env.APP_USERNAME, password: process.env.APP_PASSWORD });
      const otherCookie = otherLogin.headers.get('set-cookie').split(';')[0];
      const conversationId = crypto.randomUUID();
      response = await post('/api/chat', { conversationId, agent: 'soccer-lineup', operationId: crypto.randomUUID(), messages: [{ role: 'system', content: 'bad' }] }, newerCookie);
      assert.equal(response.status, 400);
      response = await post('/api/chat', { conversationId, agent: 'default', operationId: crypto.randomUUID(), messages: [{ role: 'user', content: 'hello' }] }, newerCookie);
      assert.equal(response.status, 409);
      response = await post('/api/change-password', { currentPassword: process.env.APP_PASSWORD, newPassword: 'Fictional-new-password-only-43' }, newerCookie);
      assert.equal(response.status, 200);
      assert.equal((await fetch(base + '/api/me', { headers: { Cookie: newerCookie } })).status, 401);
      assert.equal(await auth.verifyPassword(process.env.APP_PASSWORD), false);
      assert.equal((await fetch(base + '/api/me', { headers: { Cookie: otherCookie } })).status, 401);
      assert.equal((await fetch(base + '/', { headers: { Cookie: otherCookie }, redirect: 'manual' })).status, 200);
      assert.equal((await fetch(base + '/chat', { headers: { Cookie: otherCookie }, redirect: 'manual' })).status, 302);
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
});

test('all soccer outbound content excludes historical and standing private text', async () => {
  const username = 'outbound_fixture';
  const roster = { formation: '2-3-1', players: [] };
  soccer.addPlayerDirect(roster, { name: 'Élodie Fixture' });
  soccer.saveRoster(username, roster);
  const original = global.fetch;
  const captured = [];
  global.fetch = async (url, options) => { captured.push(JSON.parse(options.body)); return Response.json({ choices: [{ message: { content: 'Hello Player_1' } }] }); };
  const response = { setHeader() {}, write() {}, end() {}, status() { return this; }, json() {} };
  try {
    await require('../lib/soccerLineupChat').handleSoccerLineupChat(response, {
      upstreamMessages: [{ role: 'system', content: 'Private standing secret' }, { role: 'assistant', content: 'Removed Fixture and confidential warnings' }, { role: 'user', content: 'Rest Élodie Fixture in Q1' }],
      selectedModel: 'fictional', maxTokens: 500, apiKey: 'fictional', username, ownerId: 'fixture-owner', session: {}, appUrl: 'http://localhost',
    });
    assert.equal(captured.length, 1);
    const serialized = JSON.stringify(captured);
    for (const secret of ['Élodie', 'Private standing secret', 'Removed Fixture', 'confidential warnings']) assert.ok(!serialized.includes(secret));
    assert.match(serialized, /Rest Player_1 in Q1/);
  } finally { global.fetch = original; }
});

test('an interrupted provider stream reports failure instead of false completion', async () => {
  let text = '';
  const response = { setHeader() {}, write(chunk) { text += chunk; }, end() {} };
  const upstream = new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
  await require('../lib/sse').pipeUpstreamStream(upstream, response);
  assert.match(text, /partial/);
  assert.match(text, /interrupted/);
  assert.ok(!text.includes('[DONE]'));
});

test('browser modules parse after the dependency refactor', () => {
  const { execFileSync } = require('node:child_process');
  for (const name of fs.readdirSync(path.join(__dirname, '../public/js'))) {
    if (name.endsWith('.js')) execFileSync(process.execPath, ['--check', path.join(__dirname, '../public/js', name)]);
  }
});
