// The Soccer Lineup agent's chat-handling: a two-call tool-calling flow
// rather than a single passthrough. First, a non-streaming call
// (tool_choice: 'auto' — the model picks between the two tools below, or
// answers in plain text for a non-actionable message) turns the coach's
// message into a structured request:
//   - set_game_lineup: per-quarter formation/resting/pinned constraints —
//     the app schedules the actual 4-quarter game in plain JS (see
//     soccerLineup.js — an LLM enforcing AYSO's "3 quarters before a 4th"
//     rule by itself will drift on that bookkeeping as the roster grows).
//   - manage_roster: update or remove EXISTING players — the app applies
//     that as a real, targeted file edit, never as model-generated file
//     content. Adding a brand-new player is intentionally NOT available
//     through chat at all — see soccerPrivacy.js.
//
// Privacy: the model never sees a real player name. Every outbound message
// (current + prior history), the system prompt's roster listing, the tool
// call arguments, and the tool result are all in terms of opaque per-request
// labels (Player_1, Player_2, ...) built by soccerPrivacy.js. The model's
// final explanation is buffered (not token-streamed) so it can be
// de-anonymized back to real names before it ever reaches the browser —
// see bufferAndRespond() below.
const soccerLineup = require('./soccerLineup');
const soccerPrivacy = require('./soccerPrivacy');
const { addUsage } = require('./tokenUsage');

function sendLocalReply(res, text) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

// Reads the upstream SSE stream to completion, accumulating content and
// reasoning, then de-anonymizes the full text and sends it to the client
// as a single chunk (in the same shape the frontend already parses one
// piece at a time) — buffering, rather than true token streaming, is the
// deliberate trade-off that makes it safe to substitute labels back to
// real names: a label could otherwise be split across two stream chunks
// and missed.
async function bufferAndRespond(upstream, res, ctx, onUsage) {
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let contentAcc = '';
  let reasoningAcc = '';
  let finishReason = '';

  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let json;
    try {
      json = JSON.parse(payload);
    } catch {
      return;
    }
    if (json.usage) onUsage(json.usage);
    const delta = json.choices?.[0]?.delta || {};
    if (json.choices?.[0]?.finish_reason) finishReason = json.choices[0].finish_reason;
    if (typeof delta.content === 'string') contentAcc += delta.content;
    if (typeof delta.reasoning === 'string') reasoningAcc += delta.reasoning;
    if (Array.isArray(delta.reasoning_details)) {
      for (const d of delta.reasoning_details) {
        if (d.type === 'reasoning.text' && typeof d.text === 'string') reasoningAcc += d.text;
        else if (d.type === 'reasoning.summary' && typeof d.summary === 'string') reasoningAcc += d.summary;
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) handleLine(line);
  }
  if (buffer.trim()) handleLine(buffer);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (reasoningAcc) {
    res.write(
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning: soccerPrivacy.deanonymize(reasoningAcc, ctx) } }] })}\n\n`
    );
  }
  res.write(
    `data: ${JSON.stringify({
      choices: [{ delta: { content: soccerPrivacy.deanonymize(contentAcc, ctx) }, finish_reason: finishReason || null }],
    })}\n\n`
  );
  res.write('data: [DONE]\n\n');
  res.end();
}

async function handleSoccerLineupChat(res, { upstreamMessages, selectedModel, maxTokens, apiKey, username, appUrl, session }) {
  let existingRoster;
  try {
    existingRoster = soccerLineup.loadRoster(username);
  } catch {
    // A corrupt or unreadable roster file must never be treated as "no
    // roster yet" — that could lead to a chat edit silently creating a
    // fresh roster and orphaning data that's still recoverable on disk.
    return res.status(500).json({
      ok: false,
      error: 'Your roster file exists but could not be read. Open the roster panel to check its status before making further changes.',
    });
  }
  const roster = existingRoster || { formation: soccerLineup.DEFAULT_FORMATION, players: [] };
  const ctx = soccerPrivacy.buildAnonymizationContext(roster);

  const latestMessage = upstreamMessages[upstreamMessages.length - 1];

  if (latestMessage && soccerPrivacy.hasUnsupportedAttachment(latestMessage.content)) {
    return sendLocalReply(
      res,
      "Attachments aren't supported by the Soccer Lineup agent, to keep private roster data from ever being sent to the AI. " +
        'Please describe your request in plain text, or use the roster panel (👥) to manage players directly.'
    );
  }

  const { text: latestText } = soccerPrivacy.extractTextOnly(latestMessage?.content);
  if (soccerPrivacy.looksLikeAddRequest(latestText)) {
    return sendLocalReply(
      res,
      'To add a new player, please use the roster panel (👥) instead of chat — introducing a brand-new name has no ' +
        'existing roster entry to protect it, so that has to happen outside the AI conversation entirely.'
    );
  }

  const { messages: scrubbedMessages, ambiguousNames } = soccerPrivacy.scrubMessages(upstreamMessages, ctx);
  if (ambiguousNames.size > 0) {
    const names = [...ambiguousNames].join(', ');
    return sendLocalReply(
      res,
      `There's more than one player named ${names} on your roster, so I can't tell which one you mean. ` +
        'Open the roster panel to rename one of them (even just a last initial helps), then try again.'
    );
  }

  const rosterDescription = soccerPrivacy.describeRosterAnonymized(roster, ctx);
  const systemMessage = {
    role: 'system',
    content:
      'You are a soccer lineup assistant for a 7v7 team playing a standard 4-quarter AYSO game. ' +
      'Players are identified ONLY by an opaque label like "Player_3" — you are never told their real name, ' +
      'and must always refer to them by that exact label in your replies. Never invent a label that ' +
      "isn't listed below, and never guess at or refer to a player by any other name.\n\n" +
      `Today's roster:\n${rosterDescription}\n\n` +
      'Positions: every formation has exact slots — goalkeeper; left/right/center back (defender role); ' +
      'left/right wing or midfield and center mid (midfielder role, wings included); striker or left/right ' +
      'forward (forward role). Common aliases like "goalie" and "center midfield" are understood. When the ' +
      'coach names an exact slot ("left back", "right wing"), pin that exact slot. When they name only a ' +
      'general role ("play Player_2 in defense"), pin the role and let the app pick the exact slot using the ' +
      "side preference below — don't invent a specific side yourself.\n\n" +
      'Side preferences: the coach has a saved default for which side (left/right/no preference) gets the ' +
      'lower-average player (offense+defense averaged) for defenders, midfielders/wings, and forwards. A ' +
      'plain lineup request always uses these saved defaults automatically — never call update_lineup_settings ' +
      'for an ordinary lineup request. Use set_game_lineup\'s sideOverrides only when the coach says something ' +
      'is for THIS lineup/game only (e.g. "for this game, put the weaker defender on the left", "ignore side ' +
      'preferences for this lineup"); that never touches their saved defaults. Only call update_lineup_settings ' +
      'when the coach explicitly asks to save, change, or set a new DEFAULT (e.g. "make weaker defenders left my ' +
      'default", "save these as my defaults") — if what "these" refers to isn\'t clear from the conversation, ' +
      'ask the coach to confirm which role(s) and side(s) before calling it. A request can need both tools in ' +
      'the same turn (saving a new default AND scheduling a lineup) — call both when that happens; skipping one ' +
      'silently is never correct.\n\n' +
      'You have three tools, and should call one only when the coach is actually asking you to do that ' +
      'action right now — not for a question, a greeting, or a "can I give you my roster?" kind of check-in, ' +
      'which you should just answer normally in plain text instead:\n' +
      '- manage_roster: the coach wants to update ratings or remove an EXISTING player (e.g. "bump Player_3\'s defense to a 4", "remove Player_5"). ' +
      'You cannot add a new player this way — if asked, tell the coach to use the roster panel instead.\n' +
      '- set_game_lineup: the coach wants a lineup/schedule set for a game, with resting/pinned constraints keyed by quarter ("1"-"4"), referencing players by label.\n' +
      '- update_lineup_settings: the coach explicitly wants to change their SAVED default side preference for future lineups (see above).\n' +
      'You never edit the roster, save settings, or compute a schedule yourself — the app does that from your tool call(s). ' +
      'After you receive the tool result(s), explain clearly and warmly, always by label: for a roster change, confirm what changed; ' +
      'for a settings change, confirm exactly what was saved as a new default vs. what stayed the same; ' +
      'for a lineup, list each quarter (using exact position names like "Left Back"), the bench, quarters played per player, ' +
      'which side preferences actually applied and whether each was a saved default or this-lineup-only, and any warnings — ' +
      'in plain language, faithful to exactly what the tool result says, never guessing beyond it.',
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
      messages: [systemMessage, ...scrubbedMessages],
      tools: [soccerLineup.SET_GAME_LINEUP_TOOL, soccerLineup.MANAGE_ROSTER_TOOL, soccerLineup.UPDATE_LINEUP_SETTINGS_TOOL],
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
  addUsage(session, toolCallData?.usage);
  const assistantMessage = toolCallData?.choices?.[0]?.message;
  const toolCalls = assistantMessage?.tool_calls || [];
  if (toolCalls.length === 0) {
    // Not every message to this agent asks for an action — a question or a
    // check-in should just get a normal reply, not an error. The model's
    // reply may reference player labels, so it's de-anonymized the same
    // way a tool-driven explanation would be before it's sent back.
    const plainReply = assistantMessage?.content;
    if (!plainReply) {
      return res.status(502).json({ ok: false, error: 'Model did not return a response — try rephrasing.' });
    }
    return sendLocalReply(res, soccerPrivacy.deanonymize(plainReply, ctx));
  }

  // The model can ask for more than one action in a single turn — most
  // commonly "save this as my default AND schedule this game." Every tool
  // call is executed and gets its own tool-result message; none are
  // skipped. workingRoster tracks the roster across calls in the order the
  // model made them, so a manage_roster/update_lineup_settings call earlier
  // in the same turn is reflected in a set_game_lineup call later in it —
  // e.g. a rating bump applying before that same turn's lineup is scheduled.
  let workingRoster = existingRoster;
  const toolResults = [];

  for (const toolCall of toolCalls) {
    let args;
    try {
      args = JSON.parse(toolCall.function.arguments);
    } catch {
      toolResults.push({ id: toolCall.id, content: 'That request could not be understood — please try again.' });
      continue;
    }

    if (toolCall.function.name === 'manage_roster') {
      try {
        const content = await soccerLineup.withRosterLock(username, async () => {
          // Re-load fresh, inside the lock, rather than trusting the
          // snapshot taken before the (awaited) OpenRouter call above — a
          // concurrent panel edit or another chat message could have
          // changed the roster in the meantime.
          let fresh;
          try {
            fresh = soccerLineup.loadRoster(username);
          } catch {
            throw new Error('ROSTER_UNREADABLE');
          }
          const rosterForEdit = fresh || { formation: soccerLineup.DEFAULT_FORMATION, players: [] };
          const result = soccerPrivacy.applyChatRosterEdits(rosterForEdit, args, ctx);
          soccerLineup.saveRoster(username, rosterForEdit);
          workingRoster = rosterForEdit;
          return result;
        });
        toolResults.push({ id: toolCall.id, content });
      } catch (err) {
        if (err && err.message === 'ROSTER_UNREADABLE') {
          return res.status(500).json({
            ok: false,
            error: 'Your roster file exists but could not be read. Open the roster panel to check its status.',
          });
        }
        return res.status(500).json({ ok: false, error: 'Could not save the roster change — please try again.' });
      }
    } else if (toolCall.function.name === 'update_lineup_settings') {
      try {
        const content = await soccerLineup.withRosterLock(username, async () => {
          let fresh;
          try {
            fresh = soccerLineup.loadRoster(username);
          } catch {
            throw new Error('ROSTER_UNREADABLE');
          }
          const rosterForEdit = fresh || { formation: soccerLineup.DEFAULT_FORMATION, players: [] };
          // Settings updates never involve a player name or label at all —
          // no anonymization needed here, only validated left/right/none
          // values per role.
          const message = soccerLineup.applyLineupSettings(rosterForEdit, args);
          soccerLineup.saveRoster(username, rosterForEdit);
          workingRoster = rosterForEdit;
          return message;
        });
        toolResults.push({ id: toolCall.id, content });
      } catch (err) {
        if (err instanceof soccerLineup.RosterValidationError) {
          toolResults.push({ id: toolCall.id, content: `Could not save that: ${err.message}` });
          continue;
        }
        if (err && err.message === 'ROSTER_UNREADABLE') {
          return res.status(500).json({
            ok: false,
            error: 'Your roster file exists but could not be read. Open the roster panel to check its status.',
          });
        }
        return res.status(500).json({ ok: false, error: 'Could not save that setting — please try again.' });
      }
    } else {
      // set_game_lineup
      if (!workingRoster) {
        toolResults.push({
          id: toolCall.id,
          content: 'There is no roster yet — ask the coach to add players first using the roster panel (👥).',
        });
        continue;
      }
      const { args: translatedArgs, warnings: translateWarnings } = soccerPrivacy.translateSchedulingArgsToIds(args, ctx);
      const result = soccerLineup.computeGameLineup(workingRoster, translatedArgs);
      toolResults.push({ id: toolCall.id, content: soccerPrivacy.formatGameLineupResultAnonymized(result, ctx, translateWarnings) });
    }
  }

  const explainRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: baseHeaders,
    body: JSON.stringify({
      model: selectedModel,
      messages: [
        systemMessage,
        ...scrubbedMessages,
        assistantMessage,
        ...toolResults.map((tr) => ({ role: 'tool', tool_call_id: tr.id, content: tr.content })),
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
  return bufferAndRespond(explainRes, res, ctx, (u) => addUsage(session, u));
}

module.exports = { handleSoccerLineupChat };
