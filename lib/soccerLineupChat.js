const { controlledRequest, permitsTool } = require('./soccerRequest');
const { validateToolCalls } = require('./toolValidation');
const { providerFetch } = require('./provider');
// Only controlled commands and validated pseudonymous roster fields leave the server.
// Model-proposed mutations are validated, then confirmed where consequential.
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

// Carries an upstream HTTP failure's status/message out of
// requestToolDecision() so the caller can respond with the same status
// OpenRouter itself returned, rather than a generic one.
class UpstreamError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendLocalReply(res, text) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Connection', 'keep-alive');
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
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
    historyConsidered: (game.frozenInputs.rotationStatsSnapshot?.gamesConsidered || 0) > 0,
  };
}

function formatDraftToolResult(game, draft, ctx, extraNotes = [], extraWarnings = []) {
  const header = [
    `Game reference id: ${game.gameId}`,
    `Date: ${game.date}`,
    `Status: ${game.status === 'finalized' ? 'FINALIZED — this is the lineup used for this game' : 'draft — not yet marked used'}`,
  ];
  header.push(
    (game.frozenInputs.rotationStatsSnapshot?.gamesConsidered || 0) > 0
      ? 'Finalized planned assignments were considered alongside suitability and lineup variety.'
      : 'No finalized-game history was available. This option uses suitability and lineup variety.'
  );
  const body = soccerPrivacy.formatStoredGameResultAnonymized(draft.result, ctx, extraWarnings);
  return [...header, ...extraNotes, '', body].join('\n');
}

async function handleSoccerLineupChat(res, { upstreamMessages, selectedModel, maxTokens, apiKey, username, ownerId, gameId, appUrl, session }) {
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

  const canonical = controlledRequest(latestText, ctx);
  if (!canonical) return sendLocalReply(res, 'Please use a specific request such as “Create a lineup”, “Rest [current player name] in Q1”, or “Put [current player name] at left back in Q2”. Separate commands with semicolons. For privacy, free-form history, attachments and unrecognized references are not sent to AI. Use the roster panel for new or ambiguous players.');
  let gameReference = '';
  let selectedGame = null;
  if (typeof gameId === 'string' && /^[a-f0-9-]{36}$/.test(gameId)) {
    try { const game = lineupHistory.getGame(username, gameId); selectedGame = game; gameReference = ` Current saved game reference: ${game.gameId}.`; } catch {}
  }
  const scrubbedMessages = [{ role: 'user', content: canonical + gameReference }];
  const ambiguousNames = new Set();
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
    content: 'Interpret only the coach command into the offered tools. Reference players by their exact Player_N label. ' +
      'The application schedules the game; never invent assignments. Never invent a player or game reference. ' +
      'Ask for clarification if a quarter, player, or game is unspecified. ' +
      'Saved side preferences change only on an explicit default-setting request. Temporary overrides apply only to this lineup. ' +
      'Use every requested action for combined commands. Another option refers to the current saved game, not a new game. ' +
      'Use rotateMore only for an explicit request for more rotation. Pins must preserve the requested exact position or broad role. ' +
      'Do not decide fairness priorities or coaching preferences. The application handles those. ' +
      `Roster (pseudonymous labels and ratings):\n${rosterDescription}`,
  };
  const baseHeaders = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': appUrl,
    'X-Title': 'Simple LLM Chat',
  };

  // Asks the model to either call a tool or answer in plain text.
  // `extraMessages` (used only by the retry below) is appended after the
  // scrubbed conversation — never before it — so it reads as a follow-up
  // nudge, not a rewrite of what the coach actually said.
  async function requestToolDecision(extraMessages = []) {
    const toolCallRes = await providerFetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: baseHeaders,
      body: JSON.stringify({
        model: selectedModel,
        messages: [systemMessage, ...scrubbedMessages, ...extraMessages],
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
      throw new UpstreamError(toolCallRes.status, 'The AI provider could not complete this request.');
    }
    const toolCallData = await toolCallRes.json();
    addUsage(session, toolCallData?.usage);
    return toolCallData?.choices?.[0]?.message;
  }

  let assistantMessage;
  try {
    assistantMessage = await requestToolDecision();
    // A response with neither a tool call nor any text is not a valid
    // reply to anything the coach could have asked — retry once with an
    // explicit nudge before giving up, since this is model flakiness
    // (or the model briefly having no matching tool for a compound
    // request), not a real dead end, and the coach shouldn't be left with
    // an opaque error when a second attempt would likely have worked.
    if ((assistantMessage?.tool_calls || []).length === 0 && !assistantMessage?.content) {
      assistantMessage = await requestToolDecision([
        {
          role: 'system',
          content:
            'Your previous reply had no tool call and no text — that is never valid. Either call the tool that ' +
            'best matches the request (even if it only partially covers it, explaining the gap in your next ' +
            'reply), or reply in plain text explaining specifically what you cannot do and why.',
        },
      ]);
    }
  } catch (err) {
    if (err instanceof UpstreamError) {
      return res.status(err.status).json({ ok: false, error: err.message });
    }
    throw err;
  }
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
  if (!validateToolCalls(toolCalls, [soccerLineup.SET_GAME_LINEUP_TOOL, soccerLineup.MANAGE_ROSTER_TOOL, soccerLineup.UPDATE_LINEUP_SETTINGS_TOOL, lineupTools.GENERATE_LINEUP_ALTERNATIVE_TOOL, lineupTools.FINALIZE_LINEUP_TOOL], ctx)) return sendLocalReply(res, 'The AI proposed an unsupported or invalid action. Nothing was changed.');
  if (toolCalls.some(call => ['generate_lineup_alternative', 'finalize_lineup'].includes(call.function.name) && (!gameReference || JSON.parse(call.function.arguments).gameId !== gameId))) return sendLocalReply(res, 'No saved game was selected for this conversation. Open its lineup card or confirm which saved game you mean.');
  if (toolCalls.some(call => !permitsTool(canonical, call.function.name))) return sendLocalReply(res, 'The AI proposed an action you did not request. Nothing was changed.');
  const run = async response => {
  res = response;
  if (selectedGame && lineupHistory.getGame(username, gameId).selectedDraftId !== selectedGame.selectedDraftId) return sendLocalReply(res, 'The selected lineup changed. Please review the current option and request the action again.');
  if (JSON.stringify(soccerLineup.loadRoster(username)) !== JSON.stringify(existingRoster)) return sendLocalReply(res, 'The roster changed while this action was waiting. Please request it again.');
  let workingRoster = existingRoster;
  const toolResults = [];
  // The last lineup a tool call in this turn touched (create/alternative/
  // finalize) — attached to the reply so the frontend can render the
  // lineup card's buttons against it. Overwritten, not accumulated: if a
  // turn touches more than one, the most recent is what the coach is most
  // likely looking at.
  let lineupMeta = null;

  for (const toolCall of toolCalls) {
    require('./provider').throwIfCancelled();
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
        toolResults.push({ id: toolCall.id, content: 'The roster change could not be saved. Earlier successful actions remain saved; review them before retrying.' });
        break;
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
        toolResults.push({ id: toolCall.id, content: 'The settings change could not be saved. Earlier successful actions remain saved; review them before retrying.' });
        break;
      }
    } else if (toolCall.function.name === 'generate_lineup_alternative') {
      const gameId = typeof args.gameId === 'string' ? args.gameId.trim() : '';
      if (!gameId) {
        toolResults.push({ id: toolCall.id, content: 'No game reference id was given — ask the coach which saved lineup they mean.' });
        continue;
      }
      // A coach can ask for "another option" AND a specific constraint in
      // the same breath ("give me another one, but Player_2 needs to play
      // defense this time") — translate the same resting/pinned/
      // sideOverrides shape set_game_lineup uses, and layer it onto this
      // ONE regeneration without touching the game's saved constraints.
      const { args: translated, warnings: translateWarnings } = soccerPrivacy.translateSchedulingArgsToIds(args, ctx);
      const constraintOverrides = {};
      if (translated.resting) constraintOverrides.resting = translated.resting;
      if (translated.pinned) constraintOverrides.pinned = translated.pinned;
      if (translated.sideOverrides) constraintOverrides.sideOverrides = translated.sideOverrides;
      if (translated.ignoreSidePreferences != null) constraintOverrides.ignoreSidePreferences = translated.ignoreSidePreferences;
      try {
        const rotationBoost = args.rotateMore ? ROTATE_MORE_BOOST : 1;
        const { game, distinctFromPrevious } = await lineupHistory.withLineupLock(username, () =>
          lineupHistory.addAlternative(username, gameId, { rotationBoost, constraintOverrides })
        );
        const draft = game.drafts[game.selectedDraftId];
        const extraNotes = distinctFromPrevious
          ? []
          : ['Could not find a meaningfully different alternative within the current constraints and roster.'];
        if (draft.constraintOverrides) {
          extraNotes.push('This option applied the extra constraint you asked for, on top of the game\'s existing settings.');
        }
        lineupMeta = buildLineupMeta(game, draft);
        toolResults.push({ id: toolCall.id, content: formatDraftToolResult(game, draft, ctx, extraNotes, translateWarnings) });
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
    } else if (toolCall.function.name === 'set_game_lineup') {
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

  // Results and saved warnings stay local; no second AI disclosure is needed.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-store');
  const content = soccerPrivacy.deanonymize(toolResults.map(result => result.content).join('\n\n'), ctx);
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content, ...(lineupMeta ? { lineup: lineupMeta } : {}) } }] })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
  };
  const consequential = toolCalls.some(call => call.function.name !== 'set_game_lineup');
  if (consequential) {
    const id = require('./confirmations').propose(ownerId, run);
    const summary = require('./actionSummary').summarizeActions(toolCalls, ctx, selectedGame);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Review the proposed changes below. Nothing has been changed yet.\n\n' + summary, confirmation: { id } } }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    return res.end();
  }
  return run(res);

}

module.exports = { handleSoccerLineupChat };
