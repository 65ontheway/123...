// The Soccer Lineup agent's chat-handling: a two-call tool-calling flow
// rather than a single passthrough. First, a non-streaming call
// (tool_choice: 'auto' — the model picks between the two tools below, or
// answers in plain text for a non-actionable message) turns the coach's
// message into a structured request:
//   - set_game_lineup: per-quarter formation/resting/pinned constraints —
//     the app schedules the actual 4-quarter game in plain JS (see
//     soccerLineup.js — an LLM enforcing AYSO's "3 quarters before a 4th"
//     rule by itself will drift on that bookkeeping as the roster grows).
//   - manage_roster: add/update/remove players — the app applies that as a
//     real, targeted file edit, never as model-generated file content (one
//     slip in a freehanded rewrite could corrupt other players' data).
// Then a second, streamed call asks the model to explain whatever happened
// in natural language, which streams back to the client exactly like the
// plain chat flow.
const soccerLineup = require('./soccerLineup');
const { pipeUpstreamStream } = require('./sse');

async function handleSoccerLineupChat(res, { upstreamMessages, selectedModel, maxTokens, apiKey, username, appUrl }) {
  const existingRoster = soccerLineup.loadRoster(username);
  const rosterDescription = existingRoster ? soccerLineup.describeRoster(existingRoster) : '(no roster file yet)';

  const systemMessage = {
    role: 'system',
    content:
      'You are a soccer lineup assistant for a 7v7 team playing a standard 4-quarter AYSO game. ' +
      `Today's roster:\n${rosterDescription}\n\n` +
      'You have two tools, and should call one only when the coach is actually asking you to do that ' +
      'action right now — not for a question, a greeting, or a "can I give you my roster?" kind of check-in, ' +
      'which you should just answer normally in plain text instead:\n' +
      '- manage_roster: the coach wants to add, update, or remove players (e.g. "add Sarah, she\'s a 4 offense 2 defense 1 goalie", "remove Jenny", "bump Emma\'s defense to a 4").\n' +
      '- set_game_lineup: the coach wants a lineup/schedule set for a game, with resting/pinned constraints keyed by quarter ("1"-"4").\n' +
      'You never edit the roster or compute a schedule yourself — the app does that from your tool call. ' +
      'After you receive a tool result, explain it clearly and warmly: for a roster change, confirm what changed; ' +
      'for a lineup, list each quarter, the bench, quarters played per player, and any warnings in plain language.',
  };
  const baseHeaders = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': appUrl,
    'X-Title': 'Simple LLM Chat',
  };

  const toolCallRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: baseHeaders,
    body: JSON.stringify({
      model: selectedModel,
      messages: [systemMessage, ...upstreamMessages],
      tools: [soccerLineup.SET_GAME_LINEUP_TOOL, soccerLineup.MANAGE_ROSTER_TOOL],
      tool_choice: 'auto',
      stream: false,
      ...(maxTokens != null ? { max_tokens: maxTokens } : {}),
    }),
  });
  if (!toolCallRes.ok) {
    const data = await toolCallRes.json().catch(() => ({}));
    return res
      .status(toolCallRes.status)
      .json({ ok: false, error: data?.error?.message || 'OpenRouter request failed' });
  }
  const toolCallData = await toolCallRes.json();
  const assistantMessage = toolCallData?.choices?.[0]?.message;
  const toolCall = assistantMessage?.tool_calls?.[0];
  if (!toolCall) {
    // Not every message to this agent asks for an action — a question or a
    // check-in should just get a normal reply, not an error. The reply is
    // already fully generated (this call wasn't streamed), so send it back
    // as a single chunk in the same SSE shape the frontend already parses.
    const plainReply = assistantMessage?.content;
    if (!plainReply) {
      return res.status(502).json({ ok: false, error: 'Model did not return a response — try rephrasing.' });
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: plainReply } }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  let args;
  try {
    args = JSON.parse(toolCall.function.arguments);
  } catch {
    return res.status(502).json({ ok: false, error: 'Model returned an invalid request.' });
  }

  let toolResultContent;
  if (toolCall.function.name === 'manage_roster') {
    // Lazily creates the roster file on first use — a new account has no
    // pre-made roster to set up; asking the agent to add a player is what
    // creates one.
    const roster = existingRoster || { formation: soccerLineup.DEFAULT_FORMATION, players: [] };
    const messages = soccerLineup.applyRosterEdits(roster, args);
    soccerLineup.saveRoster(username, roster);
    toolResultContent = soccerLineup.formatRosterEditResult(messages);
  } else {
    if (!existingRoster) {
      toolResultContent =
        'There is no roster yet — ask the coach to add some players first (e.g. "add Sarah, Emma, and Jenny to the team").';
    } else {
      const result = soccerLineup.computeGameLineup(existingRoster, args);
      toolResultContent = soccerLineup.formatGameLineupResult(result);
    }
  }

  const explainRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: baseHeaders,
    body: JSON.stringify({
      model: selectedModel,
      messages: [
        systemMessage,
        ...upstreamMessages,
        assistantMessage,
        { role: 'tool', tool_call_id: toolCall.id, content: toolResultContent },
      ],
      stream: true,
      include_reasoning: true,
      ...(maxTokens != null ? { max_tokens: maxTokens } : {}),
    }),
  });
  if (!explainRes.ok) {
    const data = await explainRes.json().catch(() => ({}));
    return res
      .status(explainRes.status)
      .json({ ok: false, error: data?.error?.message || 'OpenRouter request failed' });
  }
  return pipeUpstreamStream(explainRes, res);
}

module.exports = { handleSoccerLineupChat };
