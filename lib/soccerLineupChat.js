// The Soccer Lineup agent's chat-handling: a two-call tool-calling flow
// rather than a single passthrough. First, a non-streaming call
// (tool_choice: 'auto' — the model picks between the tools below, or
// answers in plain text for a non-actionable message) turns the coach's
// message into one or more structured requests:
//   - set_game_lineup: creates a brand-new saved DRAFT lineup from
//     per-quarter formation/resting/pinned constraints — the app schedules
//     the actual 4-quarter game in plain JS, with seeded variety and
//     rotation-away-from-recent-history layered on top (see
//     soccerScheduling.js / soccerRotationStats.js), never a raw one-off
//     computation. An LLM enforcing AYSO's "3 quarters before a 4th" rule
//     (plus fairness-preserving variety) by itself will drift on that
//     bookkeeping as the roster grows.
//   - generate_lineup_alternative / finalize_lineup: act on an EXISTING
//     saved game (see lib/soccerLineupHistory.js) — "another option" and
//     "use this lineup." Only a finalized lineup ever counts toward future
//     rotation history.
//   - manage_roster / update_lineup_settings: unchanged from before this
//     file's draft/history support existed.
//
// Privacy: the model never sees a real player name. Every outbound message
// (current + prior history), the system prompt's roster listing, the tool
// call arguments, and every tool result (including saved-lineup results,
// via soccerPrivacy.formatStoredGameResultAnonymized) are all in terms of
// opaque per-request labels (Player_1, Player_2, ...). A game's reference
// id and date are NOT player identifiers, so they pass through as plain
// text — the model needs to see and echo a game id back to resolve "give
// me another option" on a later turn. The model's final explanation is
// buffered (not token-streamed) so it can be de-anonymized back to real
// names before it ever reaches the browser — see bufferAndRespond() below.
const soccerLineup = require('./soccerLineup');
const soccerPrivacy = require('./soccerPrivacy');
const lineupHistory = require('./soccerLineupHistory');
const lineupTools = require('./soccerLineupTools');
const { addUsage } = require('./tokenUsage');

// "Rotate positions more than last game" is a temporary, this-request-only
// boost to how strongly rotation history biases selection — it never
// loosens the suitability tolerance or any hard constraint (availability,
// AYSO fairness, exact pins), only how strongly ties get pulled toward
// fresher players. See soccerRotationStats.rotationWeight.
const ROTATE_MORE_BOOST = 3;

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
async function bufferAndRespond(upstream, res, ctx, onUsage, lineupMeta) {
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
  // Attaches the lineup card's data to this specific reply — same pattern
  // the export flow already uses (`delta.export`) for its download chip,
  // so the frontend's existing "look for extra delta fields on the final
  // chunk" handling just needs one more field, not a new mechanism.
  // gameId/date/status/rotationInfluenced are never player-identifying, so
  // this never needs de-anonymizing.
  if (lineupMeta) {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { lineup: lineupMeta } }] })}\n\n`);
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

// Builds the tool-result text for any of the three draft/history actions
// (set_game_lineup, generate_lineup_alternative, finalize_lineup) — a
// short header (game reference id, date, draft/finalized status, whether
// history actually influenced this option) followed by the lineup itself,
// fully in label space via formatStoredGameResultAnonymized. `game`/`draft`
// are the RAW, id-only records soccerLineupHistory.js's functions already
// return — never touched or re-fetched with real names, so nothing in this
// function ever sees one.
function buildLineupMeta(game, draft) {
  return {
    gameId: game.gameId,
    date: game.date,
    status: game.status,
    draftId: draft.draftId,
    rotationInfluenced: !!draft.result.rotationInfluenced,
  };
}

function formatDraftToolResult(game, draft, ctx, extraNotes = [], extraWarnings = []) {
  const header = [
    `Game reference id: ${game.gameId}`,
    `Date: ${game.date}`,
    `Status: ${game.status === 'finalized' ? 'FINALIZED — this is the lineup used for this game' : 'draft — not yet marked used'}`,
  ];
  header.push(
    draft.result.rotationInfluenced
      ? 'Recent finalized-game history influenced which players filled some slots this time.'
      : 'No recent finalized-game history was available (or needed) to influence rotation for this option.'
  );
  const body = soccerPrivacy.formatStoredGameResultAnonymized(draft.result, ctx, extraWarnings);
  return [...header, ...extraNotes, '', body].join('\n');
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
      'Every generated lineup is saved as a DRAFT with a "Game reference id" (shown in the tool result — always ' +
      'include it plainly in your reply, e.g. "(game ref: ...)", so you can look it up again later in this ' +
      'conversation) until the coach marks it used. It also has fairness/suitability-preserving variety and ' +
      'rotation away from what recent finalized games already covered built in automatically — you never need ' +
      'to ask for that, and you never compute or pick the arrangement yourself.\n' +
      '- "give me another option" / "try something different" / "rotate positions more than last game" ' +
      '(the last one: set rotateMore true) all mean generate_lineup_alternative on the SAME saved game — never ' +
      'call set_game_lineup again for these, since that would start a brand-new game instead of varying the ' +
      'existing one. Figure out which game from the conversation (usually the most recently discussed one); if ' +
      'genuinely unclear, ask rather than guess a gameId.\n' +
      '- "use this lineup" / "that\'s the one for Saturday" / "lock it in" means finalize_lineup on the game the ' +
      'coach is referring to. Only a finalized lineup ever counts toward future rotation — regenerating options ' +
      'or asking questions about a draft never does, no matter how many times.\n' +
      '- A request can combine actions in one turn (e.g. "use the last one, and also set up next week\'s game") ' +
      '— call every tool that applies; skipping one silently is never correct.\n\n' +
      'You have five tools, and should call one only when the coach is actually asking you to do that ' +
      'action right now — not for a question, a greeting, or a "can I give you my roster?" kind of check-in, ' +
      'which you should just answer normally in plain text instead:\n' +
      '- manage_roster: the coach wants to update ratings or remove an EXISTING player (e.g. "bump Player_3\'s defense to a 4", "remove Player_5"). ' +
      'You cannot add a new player this way — if asked, tell the coach to use the roster panel instead.\n' +
      '- set_game_lineup: the coach wants a NEW lineup/schedule for a game, with resting/pinned constraints keyed by quarter ("1"-"4"), referencing players by label.\n' +
      '- generate_lineup_alternative: another option for an EXISTING saved game (see above).\n' +
      '- finalize_lineup: mark an EXISTING saved game\'s lineup as used (see above).\n' +
      '- update_lineup_settings: the coach explicitly wants to change their SAVED default side preference for future lineups (see above).\n' +
      'You never edit the roster, save settings, or compute/store a schedule yourself — the app does that from ' +
      'your tool call(s). After you receive the tool result(s), explain clearly and warmly, always by label: ' +
      'for a roster change, confirm what changed; for a settings change, confirm exactly what was saved as a new ' +
      'default vs. what stayed the same; for a lineup (new, alternative, or finalized), mention its game ' +
      'reference id and date, whether it\'s a draft or finalized, list each quarter (using exact position names ' +
      'like "Left Back"), the bench, quarters played per player, which side preferences actually applied and ' +
      'whether each was a saved default or this-lineup-only, whether recent history influenced this option, and ' +
      'any warnings — in plain language, faithful to exactly what the tool result says, never guessing beyond it.',
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
      tools: [
        soccerLineup.SET_GAME_LINEUP_TOOL,
        soccerLineup.MANAGE_ROSTER_TOOL,
        soccerLineup.UPDATE_LINEUP_SETTINGS_TOOL,
        lineupTools.GENERATE_LINEUP_ALTERNATIVE_TOOL,
        lineupTools.FINALIZE_LINEUP_TOOL,
      ],
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
  // The last lineup a tool call in this turn touched (create/alternative/
  // finalize) — attached to the reply so the frontend can render the
  // lineup card's buttons against it. Overwritten, not accumulated: if a
  // turn touches more than one, the most recent is what the coach is most
  // likely looking at.
  let lineupMeta = null;

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
    } else if (toolCall.function.name === 'generate_lineup_alternative') {
      const gameId = typeof args.gameId === 'string' ? args.gameId.trim() : '';
      if (!gameId) {
        toolResults.push({ id: toolCall.id, content: 'No game reference id was given — ask the coach which saved lineup they mean.' });
        continue;
      }
      try {
        const rotationBoost = args.rotateMore ? ROTATE_MORE_BOOST : 1;
        const { game, distinctFromPrevious } = await lineupHistory.withLineupLock(username, () =>
          lineupHistory.addAlternative(username, gameId, { rotationBoost })
        );
        const draft = game.drafts[game.selectedDraftId];
        const extraNotes = distinctFromPrevious
          ? []
          : ['Could not find a meaningfully different alternative within the current constraints and roster.'];
        lineupMeta = buildLineupMeta(game, draft);
        toolResults.push({ id: toolCall.id, content: formatDraftToolResult(game, draft, ctx, extraNotes) });
      } catch (err) {
        if (err instanceof lineupHistory.LineupHistoryError && err.code === 'GAME_NOT_FOUND') {
          toolResults.push({ id: toolCall.id, content: 'No saved game matches that reference id — ask the coach to confirm which lineup they mean.' });
          continue;
        }
        toolResults.push({ id: toolCall.id, content: 'Could not generate another option — please try again.' });
      }
    } else if (toolCall.function.name === 'finalize_lineup') {
      const gameId = typeof args.gameId === 'string' ? args.gameId.trim() : '';
      if (!gameId) {
        toolResults.push({ id: toolCall.id, content: 'No game reference id was given — ask the coach which saved lineup they mean.' });
        continue;
      }
      try {
        const { game, alreadyFinalized } = await lineupHistory.withLineupLock(username, () =>
          lineupHistory.finalizeGame(username, gameId)
        );
        const draft = game.drafts[game.selectedDraftId];
        const extraNotes = alreadyFinalized ? ['This lineup was already marked used — nothing changed.'] : [];
        lineupMeta = buildLineupMeta(game, draft);
        toolResults.push({ id: toolCall.id, content: formatDraftToolResult(game, draft, ctx, extraNotes) });
      } catch (err) {
        if (err instanceof lineupHistory.LineupHistoryError && (err.code === 'GAME_NOT_FOUND' || err.code === 'DRAFT_NOT_FOUND')) {
          toolResults.push({ id: toolCall.id, content: 'No saved game matches that reference id — ask the coach to confirm which lineup they mean.' });
          continue;
        }
        toolResults.push({ id: toolCall.id, content: 'Could not mark that lineup used — please try again.' });
      }
    } else {
      // set_game_lineup — always creates a brand-new saved game/draft.
      if (!workingRoster) {
        toolResults.push({
          id: toolCall.id,
          content: 'There is no roster yet — ask the coach to add players first using the roster panel (👥).',
        });
        continue;
      }
      const { args: translatedArgs, warnings: translateWarnings } = soccerPrivacy.translateSchedulingArgsToIds(args, ctx);
      try {
        const game = await lineupHistory.withLineupLock(username, () =>
          lineupHistory.createGame(username, workingRoster, translatedArgs)
        );
        const draft = game.drafts[game.selectedDraftId];
        lineupMeta = buildLineupMeta(game, draft);
        toolResults.push({ id: toolCall.id, content: formatDraftToolResult(game, draft, ctx, [], translateWarnings) });
      } catch (err) {
        toolResults.push({ id: toolCall.id, content: 'Could not generate a lineup — please try again.' });
      }
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
  return bufferAndRespond(explainRes, res, ctx, (u) => addUsage(session, u), lineupMeta);
}

module.exports = { handleSoccerLineupChat };
