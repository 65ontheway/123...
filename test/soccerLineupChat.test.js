// End-to-end coverage for the three draft/history-aware tools wired into
// handleSoccerLineupChat (set_game_lineup, generate_lineup_alternative,
// finalize_lineup): the real handler, mocked fetch (same pattern as
// soccerPrivacyBoundary.test.js) — no real player name may ever appear in
// anything sent to the mocked "AI", and the delta.lineup SSE metadata the
// frontend's lineup card depends on must be shaped correctly.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

process.env.RAYGPT_DATA_DIR = path.join(os.tmpdir(), 'raygpt-test-lineup-chat-' + process.pid);
process.env.RAYGPT_LEGACY_ROSTER_DIR = path.join(process.env.RAYGPT_DATA_DIR, 'isolated-legacy');

const soccerLineup = require('../lib/soccerLineup');
const soccerPrivacy = require('../lib/soccerPrivacy');
const history = require('../lib/soccerLineupHistory');
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
// For tests that need the tool-decision call to return DIFFERENT responses
// across successive calls within one handleSoccerLineupChat invocation
// (e.g. the empty-response retry) — shifted one per stream:false call when
// non-null; falls back to the single `nextResponse` once exhausted.
let nextResponseQueue = null;

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
      const current = nextResponseQueue && nextResponseQueue.length > 0 ? nextResponseQueue.shift() : nextResponse;
      if (!current) return new Response(JSON.stringify({ error: { message: 'no mock configured' } }), { status: 500 });
      const calls = current.toolCalls || (current.toolCall ? [current.toolCall] : null);
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
        JSON.stringify({ usage, choices: [{ message: { role: 'assistant', content: current.content, tool_calls: null } }] }),
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
    // Parses out the final delta.lineup SSE chunk this response carries, if any —
    // same parsing chat.js itself does client-side (see public/js/chat.js).
    get lineupDelta() {
      for (const line of this.fullText.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let json;
        try {
          json = JSON.parse(payload);
        } catch {
          continue;
        }
        const delta = json.choices?.[0]?.delta;
        if (delta && delta.lineup) return delta.lineup;
      }
      return null;
    },
  };
}

const FICTIONAL_NAMES = ['Fixture Nova', 'Fixture Orion', 'Fixture Vega'];
function assertNoLeaks(label) {
  const dump = JSON.stringify(capturedRequests);
  for (const name of FICTIONAL_NAMES) {
    assert.ok(!dump.includes(name), `${label}: outbound request must never contain "${name}"\n${dump}`);
  }
}

function seedRoster(username) {
  const roster = { formation: '2-3-1', players: [] };
  const nova = soccerLineup.addPlayerDirect(roster, { name: 'Fixture Nova', offense: 4, defense: 2, goalie: 1 });
  const orion = soccerLineup.addPlayerDirect(roster, { name: 'Fixture Orion', offense: 3, defense: 3, goalie: 3 });
  const vega = soccerLineup.addPlayerDirect(roster, { name: 'Fixture Vega', offense: 2, defense: 4, goalie: 1 });
  for (let i = 0; i < 4; i++) soccerLineup.addPlayerDirect(roster, { name: `Fixture Filler ${i}`, offense: 1, defense: 1, goalie: 1 });
  soccerLineup.saveRoster(username, roster);
  return { roster, nova, orion, vega };
}

test('Soccer Lineup chat: draft/alternative/finalize tools', async (t) => {
  t.before(() => {
    soccerLineup.initRosterStorage();
    history.initLineupHistoryStorage();
    installMockFetch();
  });
  t.after(() => {
    restoreFetch();
  });

  await t.test('set_game_lineup creates a saved draft, never leaks a name, and emits delta.lineup with status "draft"', async () => {
    seedRoster('chatCoachA');
    nextResponse = { toolCall: { name: 'set_game_lineup', args: { date: '2024-09-01' } } };
    const res = makeMockRes();
    await handleSoccerLineupChat(res, {
      upstreamMessages: [{ role: 'user', content: 'Create a lineup for Saturday; Rest Fixture Nova in Q1.' }],
      selectedModel: 'test/model',
      maxTokens: 1000,
      apiKey: 'test-key',
      username: 'chatCoachA',
      appUrl: 'http://localhost',
      session: {},
    });
    assertNoLeaks('set_game_lineup');
    const lineup = res.lineupDelta;
    assert.ok(lineup && lineup.gameId, 'expected a delta.lineup chunk with a gameId');
    assert.strictEqual(lineup.date, '2024-09-01');
    assert.strictEqual(lineup.status, 'draft');
    assert.strictEqual(typeof lineup.rotationInfluenced, 'boolean');
    assert.ok(res.fullText.includes('Fixture'), 'the de-anonymized reply should read naturally to the coach');

    const saved = history.getGame('chatCoachA', lineup.gameId);
    assert.strictEqual(saved.status, 'draft');
  });

  await t.test('generate_lineup_alternative regenerates the SAME saved game, never leaks a name, and updates delta.lineup', async () => {
    const { roster } = seedRoster('chatCoachB');
    const created = await history.withLineupLock('chatCoachB', () => history.createGame('chatCoachB', roster, { date: '2024-09-02' }));

    nextResponse = { toolCall: { name: 'generate_lineup_alternative', args: { gameId: created.gameId } } };
    const res = makeMockRes();
    await handleSoccerLineupChat(res, {
      upstreamMessages: [{ role: 'user', content: 'Give me another option.' }],
      selectedModel: 'test/model',
      maxTokens: 1000,
      apiKey: 'test-key',
      username: 'chatCoachB',
      appUrl: 'http://localhost',
      session: {},
    });
    assertNoLeaks('generate_lineup_alternative');
    assert.ok(!JSON.stringify(capturedRequests).includes(created.gameId) === false, 'the gameId itself is not player-identifying and is fine to appear');
    const lineup = res.lineupDelta;
    assert.strictEqual(lineup.gameId, created.gameId, 'must regenerate the SAME game, never create a new one');

    const reopened = history.getGame('chatCoachB', created.gameId);
    assert.strictEqual(reopened.draftOrder.length, 2, 'a second draft should have been added to the existing game');
  });

  await t.test('generate_lineup_alternative with an unresolvable gameId asks for clarification instead of guessing', async () => {
    seedRoster('chatCoachC');
    nextResponse = { toolCall: { name: 'generate_lineup_alternative', args: { gameId: 'totally-made-up-id' } } };
    const res = makeMockRes();
    await handleSoccerLineupChat(res, {
      upstreamMessages: [{ role: 'user', content: 'Give me another option.' }],
      selectedModel: 'test/model',
      maxTokens: 1000,
      apiKey: 'test-key',
      username: 'chatCoachC',
      appUrl: 'http://localhost',
      session: {},
    });
    assert.strictEqual(res.lineupDelta, null, 'no lineup metadata should be attached when the game could not be resolved');
    assert.ok(res.fullText.toLowerCase().includes('no saved game'));
  });

  await t.test('generate_lineup_alternative with an added pinned constraint applies it to just this option, never leaks a name', async () => {
    const { roster, vega } = seedRoster('chatCoachPin');
    const created = await history.withLineupLock('chatCoachPin', () => history.createGame('chatCoachPin', roster, {}));
    const ctx = soccerPrivacy.buildAnonymizationContext(roster);
    const label = ctx.labelByPlayerId.get(vega.id);

    nextResponse = {
      toolCall: {
        name: 'generate_lineup_alternative',
        args: { gameId: created.gameId, pinned: { 4: { [label]: 'defender' } } },
      },
    };
    const res = makeMockRes();
    await handleSoccerLineupChat(res, {
      upstreamMessages: [{ role: 'user', content: 'Give me another option; Put Fixture Vega in defense in Q4.' }],
      selectedModel: 'test/model',
      maxTokens: 1000,
      apiKey: 'test-key',
      username: 'chatCoachPin',
      appUrl: 'http://localhost',
      session: {},
    });
    assertNoLeaks('generate_lineup_alternative with pinned override');
    const lineup = res.lineupDelta;
    assert.strictEqual(lineup.gameId, created.gameId);

    const reopened = history.getGame('chatCoachPin', created.gameId);
    const draft = reopened.drafts[reopened.selectedDraftId];
    const q4Defender = draft.result.quarters[3].lineup.some((s) => s.role === 'defender' && s.player && s.player.id === vega.id);
    assert.ok(q4Defender, 'Vega should have been pinned into a defender slot in Q4');
    assert.deepStrictEqual(reopened.frozenInputs.constraints.pinned, {}, 'the game\'s frozen constraints must remain untouched by a one-off override');
  });

  await t.test('an empty first tool-decision response is retried once and succeeds if the retry produces a reply', async () => {
    seedRoster('chatCoachRetry');
    capturedRequests = [];
    nextResponse = null;
    nextResponseQueue = [{}, { content: 'All good — nothing to schedule right now.' }];
    const res = makeMockRes();
    await handleSoccerLineupChat(res, {
      upstreamMessages: [{ role: 'user', content: 'Hello.' }],
      selectedModel: 'test/model',
      maxTokens: 1000,
      apiKey: 'test-key',
      username: 'chatCoachRetry',
      appUrl: 'http://localhost',
      session: {},
    });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.fullText.includes('All good'), 'the retried reply should reach the user instead of a dead-end error');
    const streamFalseCalls = capturedRequests.filter((r) => r.stream === false);
    assert.strictEqual(streamFalseCalls.length, 2, 'expected exactly one retry (two total tool-decision calls)');
    nextResponseQueue = null;
  });

  await t.test('two empty tool-decision responses in a row still surface the existing fallback error, not an infinite retry', async () => {
    seedRoster('chatCoachRetryFail');
    capturedRequests = [];
    nextResponse = null;
    nextResponseQueue = [{}, {}];
    const res = makeMockRes();
    await handleSoccerLineupChat(res, {
      upstreamMessages: [{ role: 'user', content: 'Hello.' }],
      selectedModel: 'test/model',
      maxTokens: 1000,
      apiKey: 'test-key',
      username: 'chatCoachRetryFail',
      appUrl: 'http://localhost',
      session: {},
    });
    assert.strictEqual(res.statusCode, 502);
    assert.ok(res.jsonBody.error.includes('did not return a response'));
    const streamFalseCalls = capturedRequests.filter((r) => r.stream === false);
    assert.strictEqual(streamFalseCalls.length, 2, 'must retry exactly once, never more');
    nextResponseQueue = null;
  });

  await t.test('finalize_lineup marks the game used, never leaks a name, and the finalized game influences a later draft\'s rotation stats', async () => {
    const { roster } = seedRoster('chatCoachD');
    const created = await history.withLineupLock('chatCoachD', () => history.createGame('chatCoachD', roster, { date: '2024-09-03' }));

    nextResponse = { toolCall: { name: 'finalize_lineup', args: { gameId: created.gameId } } };
    const res = makeMockRes();
    await handleSoccerLineupChat(res, {
      upstreamMessages: [{ role: 'user', content: 'Use this lineup.' }],
      selectedModel: 'test/model',
      maxTokens: 1000,
      apiKey: 'test-key',
      username: 'chatCoachD',
      appUrl: 'http://localhost',
      session: {},
    });
    assertNoLeaks('finalize_lineup');
    const lineup = res.lineupDelta;
    assert.strictEqual(lineup.status, 'finalized');

    const games = Object.values(history.loadGames('chatCoachD').games);
    const rotationStatsLib = require('../lib/soccerRotationStats');
    const stats = rotationStatsLib.buildRotationStats(games);
    assert.strictEqual(stats.gamesConsidered, 1, 'the finalized game should now count toward rotation history');
  });

  await t.test('finalize_lineup on an already-finalized game is idempotent and explains that in the reply', async () => {
    const { roster } = seedRoster('chatCoachE');
    const created = await history.withLineupLock('chatCoachE', () => history.createGame('chatCoachE', roster, {}));
    await history.withLineupLock('chatCoachE', () => history.finalizeGame('chatCoachE', created.gameId));

    nextResponse = { toolCall: { name: 'finalize_lineup', args: { gameId: created.gameId } } };
    const res = makeMockRes();
    await handleSoccerLineupChat(res, {
      upstreamMessages: [{ role: 'user', content: 'Use this lineup.' }],
      selectedModel: 'test/model',
      maxTokens: 1000,
      apiKey: 'test-key',
      username: 'chatCoachE',
      appUrl: 'http://localhost',
      session: {},
    });
    assert.ok(res.fullText.includes('already marked used'));
  });

  await t.test('a "rotate positions more" request sets rotateMore and never leaks a name', async () => {
    const { roster } = seedRoster('chatCoachF');
    const created = await history.withLineupLock('chatCoachF', () => history.createGame('chatCoachF', roster, {}));

    nextResponse = { toolCall: { name: 'generate_lineup_alternative', args: { gameId: created.gameId, rotateMore: true } } };
    const res = makeMockRes();
    await handleSoccerLineupChat(res, {
      upstreamMessages: [{ role: 'user', content: 'Rotate positions more than last game.' }],
      selectedModel: 'test/model',
      maxTokens: 1000,
      apiKey: 'test-key',
      username: 'chatCoachF',
      appUrl: 'http://localhost',
      session: {},
    });
    assertNoLeaks('rotate more');
    assert.ok(res.lineupDelta && res.lineupDelta.gameId === created.gameId);
  });

  await t.test('a request combining "use this lineup" AND setting up next week runs both tools in one turn', async () => {
    const { roster } = seedRoster('chatCoachG');
    const created = await history.withLineupLock('chatCoachG', () => history.createGame('chatCoachG', roster, {}));

    nextResponse = {
      toolCalls: [
        { name: 'finalize_lineup', args: { gameId: created.gameId } },
        { name: 'set_game_lineup', args: { date: '2024-09-15' } },
      ],
    };
    const res = makeMockRes();
    await handleSoccerLineupChat(res, {
      upstreamMessages: [{ role: 'user', content: 'Use this lineup; Create a lineup for 2024-09-15.' }],
      selectedModel: 'test/model',
      maxTokens: 1000,
      apiKey: 'test-key',
      username: 'chatCoachG',
      appUrl: 'http://localhost',
      session: {},
    });
    assertNoLeaks('combined finalize + new lineup');
    // Two tool calls in one turn -> lineupMeta is overwritten by the LAST one processed (the new game), per soccerLineupChat.js's own documented behavior.
    const lineup = res.lineupDelta;
    assert.notStrictEqual(lineup.gameId, created.gameId, 'the most recent tool call touched should be what the card reflects');
    assert.strictEqual(history.listGames('chatCoachG').length, 2, 'both actions must run');
    assert.strictEqual(history.getGame('chatCoachG', created.gameId).status, 'finalized');
  });

  await t.test('natural follow-ups send filtered conversation and thanks receive a normal reply', async () => {
    seedRoster('conversationCoach');
    capturedRequests = [];
    nextResponse = { content: "You're welcome!" };
    const res = makeMockRes();
    await runChat(res, {
      upstreamMessages: [
        { role: 'system', content: 'UNTRUSTED_SYSTEM_FIXTURE' },
        { role: 'user', content: 'Could Fixture Nova be a good striker?' },
        { role: 'assistant', content: 'Fixture Nova has a strong offense rating.' },
        { role: 'user', content: 'thanks!' },
      ],
      selectedModel: 'test/model', maxTokens: 500, apiKey: 'test-key',
      username: 'conversationCoach', ownerId: 'conversationCoach', appUrl: 'http://localhost', session: {},
    });
    const dump = JSON.stringify(capturedRequests);
    assert.ok(dump.includes('thanks!'));
    assert.ok(dump.includes('good striker'));
    assert.ok(!dump.includes('Fixture Nova'));
    assert.ok(!dump.includes('UNTRUSTED_SYSTEM_FIXTURE'));
    assert.ok(res.fullText.includes("You're welcome!"));
    assert.equal(history.listGames('conversationCoach').length, 0);
  });

  await t.test('a conversational draft proposal waits for confirmation', async () => {
    seedRoster('conversationProposalCoach');
    nextResponse = { toolCall: { name: 'set_game_lineup', args: { date: '2024-09-01' } } };
    const res = makeMockRes();
    await runChat(res, {
      upstreamMessages: [{ role: 'user', content: 'Could you work out a balanced option for us?' }],
      selectedModel: 'test/model', maxTokens: 1000, apiKey: 'test-key',
      username: 'conversationProposalCoach', ownerId: 'conversationProposalCoach', appUrl: 'http://localhost', session: {},
    });
    assert.ok(res.fullText.includes('confirmation'));
    assert.equal(history.listGames('conversationProposalCoach').length, 0);
  });

  await t.test('a plain question with no action needed makes no lineup-history writes and carries no delta.lineup', async () => {
    seedRoster('chatCoachH');
    nextResponse = { content: 'Sure — happy to help with that.' };
    const res = makeMockRes();
    await handleSoccerLineupChat(res, {
      upstreamMessages: [{ role: 'user', content: 'How does the rotation feature work?' }],
      selectedModel: 'test/model',
      maxTokens: 1000,
      apiKey: 'test-key',
      username: 'chatCoachH',
      appUrl: 'http://localhost',
      session: {},
    });
    assert.strictEqual(res.lineupDelta, null);
    assert.strictEqual(history.listGames('chatCoachH').length, 0);
  });
});
