// Keeps real player names out of every request the Soccer Lineup agent
// sends to OpenRouter. The model only ever sees opaque per-request labels
// (Player_1, Player_2, ...) — never a real name, never a raw player id.
// The label<->player mapping is built fresh for each incoming chat request
// and never leaves this server.
//
// What this does and doesn't guarantee, plainly: scheduling information
// (ratings, which quarter someone rests, formation) still leaves the
// server — that's the whole point of the feature, an LLM has to see
// *something* to help schedule a game. What it protects is the *name*.
// And that protection is only as good as this module's ability to
// recognize a name in free text: it can reliably scrub any name that's
// already on the roster (exact, whole-word match), but it cannot detect a
// name it has never seen before — a typo, a nickname, or a player who
// isn't on the roster yet will pass through as ordinary text. Anonymous
// labels also don't make the underlying scheduling data itself anonymous
// on their own; a determined adversary who can correlate label positions
// with other information could still learn something. This is a real,
// meaningful reduction in what leaves the server, not a cryptographic
// guarantee.
const soccerLineup = require('./soccerLineup');

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Built once per incoming chat request from the current roster. Labels are
// only stable for the lifetime of one request (they don't need to be
// stable across requests — the model only ever sees one at a time, and
// both calls in a two-call tool-calling turn share the same context
// object).
function buildAnonymizationContext(roster) {
  const labelByPlayerId = new Map();
  const idByLabel = new Map();
  const nameByLabel = new Map();
  const labelsByLowerName = new Map(); // lowercase name -> [label, ...]

  roster.players.forEach((player, index) => {
    const label = `Player_${index + 1}`;
    labelByPlayerId.set(player.id, label);
    idByLabel.set(label, player.id);
    nameByLabel.set(label, player.name);
    const key = player.name.trim().toLowerCase();
    if (!labelsByLowerName.has(key)) labelsByLowerName.set(key, []);
    labelsByLowerName.get(key).push(label);
  });

  // Longest name first so a shorter name that happens to be a prefix of a
  // longer one never gets a chance to mismatch — though \b boundaries
  // already prevent "Sam" from matching inside "Samantha" on their own,
  // this keeps the intent explicit rather than relying on that alone.
  const namesForMatching = [...new Set(roster.players.map((p) => p.name.trim()))]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const matchRegex = namesForMatching.length
    ? new RegExp(`\\b(${namesForMatching.map(escapeRegex).join('|')})\\b`, 'gi')
    : null;

  return { labelByPlayerId, idByLabel, nameByLabel, labelsByLowerName, matchRegex, roster };
}

// Finds every exact, whole-word roster-name mention in `text` and replaces
// it with that player's label. A name shared by two or more players can't
// be safely substituted (which one did the coach mean?) — those are
// reported in `ambiguousNames` instead of guessed at, and the text is
// returned with those specific mentions left alone so the caller can
// decide not to proceed.
function scrubText(text, ctx) {
  if (!text || !ctx.matchRegex) return { text: text || '', ambiguousNames: new Set() };
  const ambiguousNames = new Set();
  const scrubbed = text.replace(ctx.matchRegex, (match) => {
    const labels = ctx.labelsByLowerName.get(match.toLowerCase()) || [];
    if (labels.length === 1) return labels[0];
    if (labels.length > 1) {
      ambiguousNames.add(match);
      return match; // left as-is; caller must check ambiguousNames before sending anywhere
    }
    return match;
  });
  return { text: scrubbed, ambiguousNames };
}

// A message's `content` is a plain string, or an array of parts once
// something is attached (see messages.js on the client for the shapes).
// Only `text` parts are ever safe to forward for this agent — an image or
// file could contain anything, including a photo of the very roster this
// feature exists to protect, so those parts are stripped rather than
// forwarded, with a neutral note in their place.
function extractTextOnly(content) {
  if (typeof content === 'string') return { text: content, hadAttachment: false };
  if (Array.isArray(content)) {
    const hadAttachment = content.some((p) => p && p.type !== 'text');
    const text = content
      .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join(' ');
    return {
      text: hadAttachment ? `${text}${text ? ' ' : ''}[attachment omitted — not supported by the Soccer Lineup agent]` : text,
      hadAttachment,
    };
  }
  return { text: '', hadAttachment: false };
}

function hasUnsupportedAttachment(content) {
  return Array.isArray(content) && content.some((p) => p && p.type !== 'text');
}

// A best-effort, deliberately broad local gate: if a message looks like it
// might be trying to introduce a NEW player by name, don't send it to the
// model at all — a brand-new name has no existing roster entry to map to a
// label, so there's no way to scrub it. Biased toward false positives
// (redirecting a message that wasn't really an add-attempt is just mildly
// annoying) over false negatives (a real name reaching the model).
const ADD_INTENT_REGEX =
  /\badd\b|\bsign(?:ing)?\s*up\b|\benroll(?:ing)?\b|\bregister(?:ing)?\b|\bnew\s+(?:player|kid|girl|boy|teammate)\b/i;

function looksLikeAddRequest(text) {
  return ADD_INTENT_REGEX.test(text || '');
}

// Scrubs an entire outbound message list (the current message plus any
// prior history being replayed as context) in place — a name typed three
// turns ago and replayed as context is exactly as much of a leak as one
// typed just now. Returns the scrubbed list plus any ambiguous names found
// anywhere in it; the caller must not send anything upstream if that set
// is non-empty.
function scrubMessages(messages, ctx) {
  const ambiguousNames = new Set();
  const scrubbed = messages.map((message) => {
    if (message.role !== 'user' && message.role !== 'assistant') return message;
    const { text } = extractTextOnly(message.content);
    const result = scrubText(text, ctx);
    for (const name of result.ambiguousNames) ambiguousNames.add(name);
    return { ...message, content: result.text };
  });
  return { messages: scrubbed, ambiguousNames };
}

// The system prompt's roster listing — labels only, exactly like
// describeRoster() but with each player's label instead of their name.
function describeRosterAnonymized(roster, ctx) {
  if (roster.players.length === 0) return '(no players yet)';
  return roster.players
    .map((p) => {
      const label = ctx.labelByPlayerId.get(p.id);
      const s = p.skills || {};
      return `- ${label}: offense ${s.offense ?? '?'}, defense ${s.defense ?? '?'}, goalie ${s.goalie ?? '?'}`;
    })
    .join('\n');
}

// Translates the model's manage_roster tool call (which only ever
// reference players by label, since that's all it was shown) into actual
// roster mutations, using the id-based helpers in soccerLineup.js so a
// name shared by two players is never ambiguous — each label maps to
// exactly one player id. Builds the tool-result message in labels too,
// never a real name, so the explain step never sees one either.
function applyChatRosterEdits(roster, { update = [], remove = [] } = {}, ctx) {
  const messages = [];

  for (const entry of update) {
    const id = ctx.idByLabel.get(entry.name);
    const label = entry.name;
    if (!id) {
      messages.push(`Could not find a player matching ${label}.`);
      continue;
    }
    const changed = [];
    for (const key of ['offense', 'defense', 'goalie']) {
      if (entry[key] != null) changed.push(key);
    }
    // Only ratings, never `name` — entry.name is the player's label (how
    // the model identifies who to update), not a rename request. Chat
    // can't rename a player at all; passing entry.name through here would
    // overwrite their real name with the literal label text.
    const player = soccerLineup.updatePlayerDirect(roster, id, {
      offense: entry.offense,
      defense: entry.defense,
      goalie: entry.goalie,
    });
    if (!player || changed.length === 0) {
      messages.push(`No rating changes given for ${label}.`);
      continue;
    }
    messages.push(`Updated ${label}: ${changed.map((k) => `${k} ${player.skills[k]}`).join(', ')}.`);
  }

  for (const label of remove) {
    const id = ctx.idByLabel.get(label);
    if (!id) {
      messages.push(`Could not find a player matching ${label}.`);
      continue;
    }
    const removed = soccerLineup.removePlayerDirect(roster, id);
    messages.push(removed ? `Removed ${label}.` : `Could not find a player matching ${label}.`);
  }

  return messages.length > 0 ? messages.join('\n') : 'No changes were requested.';
}

const VALID_QUARTERS = new Set(['1', '2', '3', '4']);
const VALID_SIDE_OVERRIDE_ROLES = new Set(['defender', 'midfielder', 'forward']);
const VALID_SIDE_OVERRIDE_VALUES = new Set(['left', 'right', 'none']);

// Translates set_game_lineup's label-keyed resting/pinned maps into the
// id-keyed shape computeGameLineup() expects. Position/side-preference
// tokens (e.g. "left_back", "none") aren't player identifiers, so they
// pass through unchanged — soccerLineup.js's own validation handles those
// against the effective formation. What this function is responsible for
// validating is anything that names a PLAYER or a QUARTER, since those are
// the only pieces this layer can resolve (it's the only place that still
// has the label mapping): an unrecognized quarter key, a label that
// doesn't match any player, or a malformed sideOverrides entry is reported
// as a warning here rather than silently dropped, same policy
// computeGameLineup already uses for everything else.
function translateSchedulingArgsToIds(args, ctx) {
  const translated = { formation: args.formation };
  const warnings = [];

  if (args.resting) {
    translated.resting = {};
    for (const [quarter, labels] of Object.entries(args.resting)) {
      if (!VALID_QUARTERS.has(quarter)) {
        warnings.push(`"${quarter}" isn't a valid quarter (use 1-4) — that resting entry was ignored.`);
        continue;
      }
      const ids = [];
      for (const label of labels || []) {
        const id = ctx.idByLabel.get(label);
        if (id) ids.push(id);
        else warnings.push(`Q${quarter}: ${label} doesn't match a player on this roster — ignored.`);
      }
      translated.resting[quarter] = ids;
    }
  }
  if (args.pinned) {
    translated.pinned = {};
    for (const [quarter, byLabel] of Object.entries(args.pinned)) {
      if (!VALID_QUARTERS.has(quarter)) {
        warnings.push(`"${quarter}" isn't a valid quarter (use 1-4) — that pin entry was ignored.`);
        continue;
      }
      const byId = {};
      for (const [label, position] of Object.entries(byLabel || {})) {
        const id = ctx.idByLabel.get(label);
        if (id) byId[id] = position;
        else warnings.push(`Q${quarter}: ${label} doesn't match a player on this roster — that pin was ignored.`);
      }
      translated.pinned[quarter] = byId;
    }
  }
  if (args.sideOverrides && typeof args.sideOverrides === 'object') {
    translated.sideOverrides = {};
    for (const [role, value] of Object.entries(args.sideOverrides)) {
      if (!VALID_SIDE_OVERRIDE_ROLES.has(role)) {
        warnings.push(`"${role}" isn't a role with a side preference (use defender, midfielder, or forward) — ignored.`);
        continue;
      }
      if (!VALID_SIDE_OVERRIDE_VALUES.has(value)) {
        warnings.push(`"${value}" isn't a valid side preference for ${role} (use left, right, or none) — ignored.`);
        continue;
      }
      translated.sideOverrides[role] = value;
    }
  }
  if (args.ignoreSidePreferences != null) translated.ignoreSidePreferences = !!args.ignoreSidePreferences;

  return { args: translated, warnings };
}

// The lineup result's structured parts (lineup slots, bench) already
// reference real player objects with ids, so they're translated directly
// — no text scanning needed, and therefore nothing fragile. `warnings`
// (both computeGameLineup's own, and any passed in from an earlier
// validation step like translateSchedulingArgsToIds) are free-text
// sentences written in real-name-space, so those go through scrubText as
// a backstop; any name in them is guaranteed to be an exact roster name,
// never user-typed text (the caller already scrubbed the request before
// this ever ran).
function formatGameLineupResultAnonymized(result, ctx, extraWarnings = []) {
  const lines = [`Formation: ${result.formation}`, '', 'Side preferences applied this lineup:'];
  for (const entry of result.sidePreferencesApplied) {
    const valueLabel = entry.value === 'left' ? 'Left' : entry.value === 'right' ? 'Right' : 'No preference';
    const sourceLabel = entry.source === 'temporary' ? 'this lineup only' : 'saved default';
    lines.push(`- ${entry.role[0].toUpperCase()}${entry.role.slice(1)} → ${valueLabel} (${sourceLabel})`);
  }
  for (const { quarter, lineup, bench } of result.quarters) {
    lines.push('', `Quarter ${quarter}:`);
    for (const slot of lineup) {
      const posLabel = soccerLineup.POSITION_CATALOG[slot.position]?.label || slot.position;
      const playerLabel = slot.player ? ctx.labelByPlayerId.get(slot.player.id) || '(unknown)' : '(unfilled)';
      lines.push(`${posLabel}: ${playerLabel}`);
    }
    if (bench.length > 0) {
      lines.push(`Bench: ${bench.map((p) => ctx.labelByPlayerId.get(p.id) || '(unknown)').join(', ')}`);
    }
  }
  lines.push('', 'Quarters played this game:');
  for (const entry of result.quartersPlayedSummary) {
    lines.push(`${ctx.labelByPlayerId.get(entry.id) || '(unknown)'}: ${entry.quartersPlayed}`);
  }
  const allWarnings = [...extraWarnings, ...result.warnings];
  if (allWarnings.length > 0) {
    lines.push('', 'Warnings:');
    for (const warning of allWarnings) {
      lines.push(`- ${scrubText(warning, ctx).text}`);
    }
  }
  return lines.join('\n');
}

// The inverse of scrubText: turns the model's label-only explanation back
// into real names right before it reaches the browser. Only replaces
// labels this context actually knows about — anything else (a label the
// model invented, or plain text) is left untouched rather than guessed at.
function deanonymize(text, ctx) {
  if (!text) return text;
  return text.replace(/\bPlayer_(\d+)\b/g, (match) => ctx.nameByLabel.get(match) || match);
}

module.exports = {
  buildAnonymizationContext,
  scrubText,
  scrubMessages,
  extractTextOnly,
  hasUnsupportedAttachment,
  looksLikeAddRequest,
  describeRosterAnonymized,
  applyChatRosterEdits,
  translateSchedulingArgsToIds,
  formatGameLineupResultAnonymized,
  deanonymize,
};
