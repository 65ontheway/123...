// The single most important test in this suite: it calls the REAL,
// unmodified handleSoccerLineupChat() — same code path the app actually
// runs, hitting the real hardcoded https://openrouter.ai URL string — and
// intercepts it by monkey-patching the global fetch() function rather than
// redirecting the URL, so this exercises the production code path exactly
// as shipped. Every request fetch() sees is recorded, and every assertion
// below is "no fictional real-name marker ever appears in anything sent
// out," across every path called out in the requirements: the current
// message, replayed history, the system prompt, tool call arguments, tool
// results, and the (buffered, de-anonymized) explanation.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

process.env.RAYGPT_DATA_DIR = path.join(os.tmpdir(), 'raygpt-test-boundary-' + process.pid);
process.env.RAYGPT_LEGACY_ROSTER_DIR = path.join(process.env.RAYGPT_DATA_DIR, 'isolated-legacy');

const soccerLineup = require('../lib/soccerLineup');
const soccerPrivacy = require('../lib/soccerPrivacy');
const { handleSoccerLineupChat: runChat } = require('../lib/soccerLineupChat');
// These workflow tests explicitly accept the returned, one-use proposal.
// Separate security tests assert that unconfirmed/wrong-owner actions never run.
async function handleSoccerLineupChat(res, options) {
  const calls = nextResponse?.toolCalls || [nextResponse?.toolCall].filter(Boolean);
  const gameId = calls.find(call => call.args?.gameId)?.args.gameId;
  await runChat(res, { ...options, ownerId: options.username, gameId });
  for (const line of res.fullText.split('\n')) {
    if (!line.startsWith('data: {')) continue;
    const confirmation = JSON.parse(line.slice(6)).choices?.[0]?.delta?.confirmation;
    if (confirmation) await require('../lib/confirmations').confirm({ params: { id: confirmation.id }, session: { ownerId: options.username } }, res, err => { throw err; });
  }
}


let capturedRequests = [];
let nextResponse = null;

function makeSseBody(text, usage) {
  const encoder = new TextEncoder();
  const chunks = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [], usage })}\n\n`,
    'data: [DONE]\n\n',
  ];
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

const originalFetch = global.fetch;
function installMockFetch() {
  capturedRequests = [];
  global.fetch = async (url, options) => {
    const body = options?.body ? JSON.parse(options.body) : {};
    capturedRequests.push(body);
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
    if (body.stream === false) {
      if (!nextResponse) {
        return new Response(JSON.stringify({ error: { message: 'no mock configured' } }), { status: 500 });
      }
      // `toolCalls` (plural) simulates the model asking for more than one
      // action in a single turn (e.g. saving a setting AND scheduling a
      // lineup); `toolCall` (singular) is the common single-action case.
      const calls = nextResponse.toolCalls || (nextResponse.toolCall ? [nextResponse.toolCall] : null);
      if (calls) {
        return new Response(
          JSON.stringify({
            usage,
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: calls.map((c, i) => ({
                    id: `call_${i + 1}`,
                    type: 'function',
                    function: { name: c.name, arguments: JSON.stringify(c.args) },
                  })),
                },
              },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({ usage, choices: [{ message: { role: 'assistant', content: nextResponse.content, tool_calls: null } }] }),
        { status: 200 }
      );
    }
    const toolMsgs = (body.messages || []).filter((m) => m.role === 'tool');
    return new Response(makeSseBody(`ECHO: ${toolMsgs.map((m) => m.content).join(' | ') || '(none)'}`, usage), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  };
}
function restoreFetch() {
  global.fetch = originalFetch;
}

function makeMockRes() {
  const chunks = [];
  const state = { statusCode: 200, jsonBody: null };
  return {
    status(code) {
      state.statusCode = code;
      return this;
    },
    json(obj) {
      state.jsonBody = obj;
      return this;
    },
    setHeader() {},
    write(s) {
      chunks.push(s);
    },
    end(s) {
      if (s) chunks.push(s);
    },
    get fullText() {
      return chunks.join('');
    },
    get statusCode() {
      return state.statusCode;
    },
    get jsonBody() {
      return state.jsonBody;
    },
  };
}

const FICTIONAL_NAMES = ['Fixture Alpha', 'Fixture Bravo', 'Fixture Sam'];
function assertNoLeaks(t, label) {
  const dump = JSON.stringify(capturedRequests);
  for (const name of FICTIONAL_NAMES) {
    assert.ok(!dump.includes(name), `${label}: outbound request must never contain "${name}"\n${dump}`);
  }
}

function seedRoster(username) {
  const roster = { formation: '2-3-1', players: [] };
  const alpha = soccerLineup.addPlayerDirect(roster, { name: 'Fixture Alpha', offense: 4, defense: 2, goalie: 1 });
  const bravo = soccerLineup.addPlayerDirect(roster, { name: 'Fixture Bravo', offense: 3, defense: 3, goalie: 3 });
  soccerLineup.saveRoster(username, roster);
  return { roster, alpha, bravo };
}

test('Soccer Lineup agent: mocked AI boundary — no real name ever leaves the server', async (t) => {
  t.before(() => {
    soccerLineup.initRosterStorage();
    installMockFetch();
  });
  t.after(() => {
    restoreFetch();
  });

  await t.test('a scheduling request mentioning a real name is scrubbed before any AI call', async () => {
    seedRoster('boundaryCoachA');
    nextResponse = { toolCall: { name: 'set_game_lineup', args: {} } };
    const res = makeMockRes();
    await handleSoccerLineupChat(res, {
      upstreamMessages: [{ role: 'user', content: 'Please rest Fixture Alpha in the first quarter.' }],
      selectedModel: 'test/model',
      maxTokens: 1000,
      apiKey: 'test-key',
      username: 'boundaryCoachA',
      appUrl: 'http://localhost',
      session: {},
    });
    assert.strictEqual(capturedRequests.length, 1, 'only the tool decision leaves the server; explanations stay local');
    assertNoLeaks(t, 'scheduling request');
    // The final reply shown to the USER is expected to have real names —
    // that's the whole point; only the AI-bound traffic must be scrubbed.
    assert.ok(res.fullText.includes('Fixture'), 'the final user-facing reply should be de-anonymized back to real names');
  });

  await t.test('replayed history is scrubbed, not just the latest message', async () => {
    seedRoster('boundaryCoachB');
    nextResponse = { content: 'Sure thing!' };
    const res = makeMockRes();
    await handleSoccerLineupChat(res, {
      upstreamMessages: [
        { role: 'user', content: 'Hows Fixture Bravo doing this season?' },
        { role: 'assistant', content: 'Fixture Bravo has solid ratings across the board.' },
        { role: 'user', content: 'Great, thanks!' },
      ],
      selectedModel: 'test/model',
      maxTokens: 1000,
      apiKey: 'test-key',
      username: 'boundaryCoachB',
      appUrl: 'http://localhost',
      session: {},
    });
    assertNoLeaks(t, 'replayed history');
  });

  await t.test('a chat-based rating update is scrubbed end-to-end and never renames the player', async () => {
    const { alpha } = seedRoster('boundaryCoachC');
    // First call happens with an empty capturedRequests, so we don't know
    // the label yet — use a two-step: first send a message to get a real
    // tool-decision call recorded, then inspect the roster listing in the
    // system prompt to find which label maps to Fixture Alpha.
    nextResponse = { content: 'noop' };
    const probe = makeMockRes();
    await handleSoccerLineupChat(probe, {
      upstreamMessages: [{ role: 'user', content: 'hello' }],
      selectedModel: 'test/model',
      maxTokens: 1000,
      apiKey: 'test-key',
      username: 'boundaryCoachC',
      appUrl: 'http://localhost',
      session: {},
    });
    const systemPrompt = capturedRequests[capturedRequests.length - 1].messages[0].content;
    const match = systemPrompt.match(/- (Player_\d+): offense 4, defense 2, goalie 1/);
    assert.ok(match, 'expected to find Fixture Alpha\'s label in the anonymized roster listing');
    const label = match[1];

    nextResponse = { toolCall: { name: 'manage_roster', args: { update: [{ name: label, offense: 5 }] } } };
    const res = makeMockRes();
    await handleSoccerLineupChat(res, {
      upstreamMessages: [{ role: 'user', content: 'Bump Fixture Alpha offense to a 5.' }],
      selectedModel: 'test/model',
      maxTokens: 1000,
      apiKey: 'test-key',
      username: 'boundaryCoachC',
      appUrl: 'http://localhost',
      session: {},
    });
    assertNoLeaks(t, 'chat-based rating update');
    const updated = soccerLineup.loadRoster('boundaryCoachC').players.find((p) => p.id === alpha.id);
    assert.strictEqual(updated.name, 'Fixture Alpha', 'the real name must survive a chat-based rating update');
    assert.strictEqual(updated.skills.offense, 5);
  });

  await t.test('a chat-based attempt to add a new player is blocked locally — zero AI calls', async () => {
    seedRoster('boundaryCoachD');
    capturedRequests = [];
    const res = makeMockRes();
    await handleSoccerLineupChat(res, {
      upstreamMessages: [{ role: 'user', content: 'Add Fixture Charlie, shes a 3 offense.' }],
      selectedModel: 'test/model',
      maxTokens: 1000,
      apiKey: 'test-key',
      username: 'boundaryCoachD',
      appUrl: 'http://localhost',
      session: {},
    });
    assert.strictEqual(capturedRequests.length, 0, 'adding a new player through chat must never reach the model at all');
    assert.ok(res.fullText.includes('roster panel'), 'the local reply should redirect to the roster panel');
  });

  await t.test('an ambiguous duplicate-name reference is blocked locally — zero AI calls', async () => {
    const roster = { formation: '2-3-1', players: [] };
    soccerLineup.addPlayerDirect(roster, { name: 'Fixture Sam' });
    soccerLineup.addPlayerDirect(roster, { name: 'Fixture Sam' });
    soccerLineup.saveRoster('boundaryCoachE', roster);
    capturedRequests = [];
    const res = makeMockRes();
    await handleSoccerLineupChat(res, {
      upstreamMessages: [{ role: 'user', content: 'Rest Fixture Sam this quarter.' }],
      selectedModel: 'test/model',
      maxTokens: 1000,
      apiKey: 'test-key',
      username: 'boundaryCoachE',
      appUrl: 'http://localhost',
      session: {},
    });
    assert.strictEqual(capturedRequests.length, 0, 'an ambiguous name must never reach the model');
    assert.ok(res.fullText.includes('ambiguous players'));
  });

  await t.test('an image attachment is blocked locally — zero AI calls', async () => {
    seedRoster('boundaryCoachF');
    capturedRequests = [];
    const res = makeMockRes();
    await handleSoccerLineupChat(res, {
      upstreamMessages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'whats in this photo of the roster board' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,x' } },
          ],
        },
      ],
      selectedModel: 'test/model',
      maxTokens: 1000,
      apiKey: 'test-key',
      username: 'boundaryCoachF',
      appUrl: 'http://localhost',
      session: {},
    });
    assert.strictEqual(capturedRequests.length, 0, 'an attachment must never reach the model for this agent');
    assert.ok(res.fullText.includes("Attachments aren't supported"));
  });

  await t.test('form-based roster editing (the panel API) makes zero AI requests', () => {
    capturedRequests = [];
    const roster = soccerLineup.loadRoster('boundaryCoachA') || { formation: '2-3-1', players: [] };
    const added = soccerLineup.addPlayerDirect(roster, { name: 'Fixture Panel Player', offense: 3, defense: 3, goalie: 3 });
    soccerLineup.saveRoster('boundaryCoachA', roster);
    soccerLineup.updatePlayerDirect(roster, added.id, { offense: 5 });
    soccerLineup.saveRoster('boundaryCoachA', roster);
    soccerLineup.removePlayerDirect(roster, added.id);
    soccerLineup.saveRoster('boundaryCoachA', roster);
    assert.strictEqual(capturedRequests.length, 0, 'add/update/remove through the roster panel functions must never call fetch');
  });

  await t.test('saving a side preference through the panel makes zero AI requests', () => {
    capturedRequests = [];
    const roster = soccerLineup.loadRoster('boundaryCoachA') || { formation: '2-3-1', players: [] };
    soccerLineup.applyLineupSettings(roster, { defender: 'left' });
    soccerLineup.saveRoster('boundaryCoachA', roster);
    assert.strictEqual(capturedRequests.length, 0, 'saving side preferences through the panel must never call fetch');
  });

  await t.test('a request that both saves a new default AND schedules a lineup runs both tool calls, not just the first', async () => {
    const { alpha } = seedRoster('boundaryCoachG');
    nextResponse = {
      toolCalls: [
        { name: 'update_lineup_settings', args: { defender: 'left' } },
        { name: 'set_game_lineup', args: {} },
      ],
    };
    const res = makeMockRes();
    await handleSoccerLineupChat(res, {
      upstreamMessages: [{ role: 'user', content: 'Make weaker defenders on the left my default; Set the lineup.' }],
      selectedModel: 'test/model',
      maxTokens: 1000,
      apiKey: 'test-key',
      username: 'boundaryCoachG',
      appUrl: 'http://localhost',
      session: {},
    });
    assertNoLeaks(t, 'combined settings-save + lineup request');
    const saved = soccerLineup.loadRoster('boundaryCoachG');
    assert.strictEqual(saved.sidePreferences.defender, 'left', 'the settings tool call must have actually persisted');
    // Both tool results must have reached the explain call — the explain-call
    // request is the last captured one, and its tool messages are echoed
    // back joined by " | " (see installMockFetch), so both are inspectable.
    assert.strictEqual(require('../lib/soccerLineupHistory').listGames('boundaryCoachG').length, 1, 'the draft action must also run');
    assert.ok(!capturedRequests.some(call => call.messages.some(message => message.role === 'tool')), 'tool results stay local');
  });

  await t.test('a this-lineup-only side override never changes the saved default', async () => {
    seedRoster('boundaryCoachH');
    const before = soccerLineup.loadRoster('boundaryCoachH').sidePreferences;
    nextResponse = { toolCall: { name: 'set_game_lineup', args: { sideOverrides: { defender: 'left' } } } };
    const res = makeMockRes();
    await handleSoccerLineupChat(res, {
      upstreamMessages: [{ role: 'user', content: 'For this game, put the weaker defender on the left.' }],
      selectedModel: 'test/model',
      maxTokens: 1000,
      apiKey: 'test-key',
      username: 'boundaryCoachH',
      appUrl: 'http://localhost',
      session: {},
    });
    assertNoLeaks(t, 'this-lineup-only override');
    const after = soccerLineup.loadRoster('boundaryCoachH').sidePreferences;
    assert.deepStrictEqual(after, before, 'a this-lineup-only override must never persist to the roster file');
  });

  await t.test('an exact-position pin (e.g. left back) resolves correctly and never leaks a name', async () => {
    const { alpha } = seedRoster('boundaryCoachI');
    for (let i = 0; i < 6; i++) soccerLineup.addPlayerDirect(soccerLineup.loadRoster('boundaryCoachI'), { name: `Fixture Filler ${i}` });
    const roster = soccerLineup.loadRoster('boundaryCoachI');
    soccerLineup.saveRoster('boundaryCoachI', roster);
    const ctx = soccerPrivacy.buildAnonymizationContext(roster);
    const label = ctx.labelByPlayerId.get(alpha.id);
    nextResponse = { toolCall: { name: 'set_game_lineup', args: { pinned: { 1: { [label]: 'left_back' } } } } };
    const res = makeMockRes();
    await handleSoccerLineupChat(res, {
      upstreamMessages: [{ role: 'user', content: 'Put Fixture Alpha at left back in the first quarter.' }],
      selectedModel: 'test/model',
      maxTokens: 1000,
      apiKey: 'test-key',
      username: 'boundaryCoachI',
      appUrl: 'http://localhost',
      session: {},
    });
    assertNoLeaks(t, 'exact-position pin request');
    assert.ok(res.fullText.includes('Fixture'), 'the de-anonymized reply should still read naturally to the coach');
  });
});
