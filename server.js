require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const soccerLineup = require('./lib/soccerLineup');
const { pipeUpstreamStream } = require('./lib/sse');
const { handleSoccerLineupChat } = require('./lib/soccerLineupChat');
const exportLib = require('./lib/export');
const exportStore = require('./lib/exportStore');
const exportChat = require('./lib/exportChat');
const auth = require('./lib/auth');
const { addUsage } = require('./lib/tokenUsage');
const soccerPrivacy = require('./lib/soccerPrivacy');
const { PrivateDataConfigError } = require('./lib/privateData');
const soccerRosterRoutes = require('./lib/soccerRosterRoutes');
const soccerLineupRoutes = require('./lib/soccerLineupRoutes');
const soccerLineupHistory = require('./lib/soccerLineupHistory');

const app = express();
const PORT = process.env.PORT || 3000;

// Default 100kb body limit is too small once messages can carry base64-encoded
// images and PDFs; images are downscaled client-side first, but a multi-turn
// thread resends its whole history (including past attachments) on every request.
app.use(express.json({ limit: '30mb' }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-only-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 4, // 4 hours
    },
  })
);

app.use(express.static(path.join(__dirname, 'public')));

// Serve browser-ready bundles directly from node_modules, so the page isn't
// dependent on a third-party CDN: marked/DOMPurify render assistant Markdown,
// mammoth/exceljs extract text from uploaded Word/Excel files client-side so
// their contents can be attached as plain text without a server round-trip.
app.get('/vendor/marked.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules/marked/lib/marked.umd.js'));
});
app.get('/vendor/dompurify.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules/dompurify/dist/purify.min.js'));
});
app.get('/vendor/mammoth.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules/mammoth/mammoth.browser.min.js'));
});
app.get('/vendor/exceljs.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules/exceljs/dist/exceljs.min.js'));
});

// Curated high-power open-weight models available through OpenRouter, listed
// cheapest to most expensive (per-token pricing, input and output orderings
// happen to agree). Qwen3.8 27B is a fixed mid-range model labeled as the
// default (not OpenRouter's own dynamic auto-router) — the sensible choice
// for anything that isn't a heavy question; the rest are flagship-tier
// options for when more firepower is wanted.
const AVAILABLE_MODELS = [
  { id: 'deepseek/deepseek-v3.2', label: 'DeepSeek V3.2' },
  { id: 'qwen/qwen3.8-27b', label: 'Qwen3.8 27B (Default)' },
  { id: 'tencent/hy4-preview', label: 'Hy4 Preview' },
  { id: 'z-ai/glm-5.3', label: 'GLM-5.3' },
  { id: 'meta/muse-spark-1.2', label: 'Muse Spark 1.2' },
  { id: 'qwen/qwen3.8-max-0902', label: 'Qwen3.8 Max' },
  { id: 'moonshotai/kimi-k3', label: 'Kimi K3' },
];
const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || 'qwen/qwen3.8-27b';
const VALID_MODEL_IDS = new Set([...AVAILABLE_MODELS.map((m) => m.id), DEFAULT_MODEL]);

// Response length is chosen per-message from the sidebar rather than fixed
// server-side. "long" sends no max_tokens at all (bounded only by the
// model's own limit) rather than some arbitrarily large number.
const RESPONSE_LENGTH_TOKENS = { short: 500, medium: 1000, long: null };
const DEFAULT_RESPONSE_LENGTH = 'medium';

// General Assistant is the plain passthrough chat flow. Soccer Lineup is a
// real tool-calling agent (see lib/soccerLineup.js and the branch in
// POST /api/chat below) — the model only extracts constraints from the
// coach's request; the actual lineup is computed deterministically in JS.
const AVAILABLE_AGENTS = [
  { id: 'default', label: 'General Assistant' },
  { id: soccerLineup.AGENT_ID, label: soccerLineup.AGENT_LABEL },
];
const VALID_AGENT_IDS = new Set(AVAILABLE_AGENTS.map((a) => a.id));

// Used only for the one-off "generate a short title for this chat" call, never
// exposed as a user-selectable option. Reuses the cheapest model already in
// AVAILABLE_MODELS (verified to exist on OpenRouter) rather than a separate,
// unverified slug — titling a couple hundred tokens on it is effectively free.
const TITLE_MODEL = 'deepseek/deepseek-v3.2';

// OpenRouter periodically deprecates/removes models. Rather than let a dead entry
// sit in the dropdown until someone hits "No endpoints found", cross-check the
// curated list against OpenRouter's live catalog and quietly drop anything that's
// disappeared. Cached, and fails open to the full curated list if the catalog
// fetch doesn't succeed, so a network hiccup never breaks the model picker.
//
// The same catalog fetch also carries each model's `architecture.input_modalities`
// (e.g. ["text", "image", "file"]), which is reused to decide whether the chat UI
// should offer image upload for the selected model — no separate request needed.
let modelCatalogCache = { models: null, fetchedAt: 0 };
const MODEL_CATALOG_TTL_MS = 60 * 60 * 1000; // 1 hour

async function getLiveModelCatalog() {
  const now = Date.now();
  if (modelCatalogCache.models && now - modelCatalogCache.fetchedAt < MODEL_CATALOG_TTL_MS) {
    return modelCatalogCache.models;
  }
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return modelCatalogCache.models;
    const data = await res.json();
    if (!Array.isArray(data?.data)) return modelCatalogCache.models;
    const models = new Map(
      data.data.map((m) => {
        // Prefer the documented `architecture.input_modalities` path, but fall
        // back to a top-level field in case OpenRouter ever flattens the shape.
        const inputModalities = m.architecture?.input_modalities || m.input_modalities || [];
        const supportsImages = Array.isArray(inputModalities) && inputModalities.includes('image');
        return [m.id, { supportsImages }];
      })
    );
    modelCatalogCache = { models, fetchedAt: now };
    return models;
  } catch {
    return modelCatalogCache.models;
  }
}

// A standing set of facts always included as a system message, independent of
// which model is selected. Re-read whenever the file's mtime changes, so edits
// take effect without restarting the server.
const FACTS_FILE = path.join(__dirname, process.env.FACTS_FILE || 'facts.md');
let factsCache = { content: '', mtimeMs: 0 };

function loadFacts() {
  try {
    const mtimeMs = fs.statSync(FACTS_FILE).mtimeMs;
    if (mtimeMs !== factsCache.mtimeMs) {
      factsCache = { content: fs.readFileSync(FACTS_FILE, 'utf8').trim(), mtimeMs };
    }
  } catch {
    factsCache = { content: '', mtimeMs: 0 };
  }
  return factsCache.content;
}

function requireAuth(req, res, next) {
  if (req.session && req.session.loggedIn) return next();
  return res.status(401).json({ ok: false, error: 'Not authenticated' });
}

app.get('/', (req, res) => {
  if (req.session && req.session.loggedIn) return res.redirect('/chat');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const expectedUser = process.env.APP_USERNAME || 'admin';

  const valid =
    typeof username === 'string' &&
    typeof password === 'string' &&
    auth.credentialsMatch(username, expectedUser) &&
    auth.verifyPassword(password);

  if (!valid) {
    return res.status(401).json({ ok: false, error: 'Invalid username or password.' });
  }

  req.session.loggedIn = true;
  req.session.username = username;
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/chat', (req, res) => {
  if (!req.session || !req.session.loggedIn) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'views', 'chat.html'));
});

app.get('/profile', (req, res) => {
  if (!req.session || !req.session.loggedIn) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'views', 'profile.html'));
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ ok: true, username: req.session.username });
});

app.get('/api/session-usage', requireAuth, (req, res) => {
  res.json({ ok: true, usage: req.session.tokenUsage || { promptTokens: 0, completionTokens: 0, totalTokens: 0 } });
});

app.post('/api/change-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (typeof currentPassword !== 'string' || !auth.verifyPassword(currentPassword)) {
    return res.status(401).json({ ok: false, error: 'Current password is incorrect.' });
  }
  if (typeof newPassword !== 'string' || newPassword.length < 6) {
    return res.status(400).json({ ok: false, error: 'New password must be at least 6 characters.' });
  }
  auth.setPassword(newPassword);
  res.json({ ok: true });
});

app.get('/api/models', requireAuth, async (req, res) => {
  const liveCatalog = await getLiveModelCatalog();
  const curated = liveCatalog
    ? AVAILABLE_MODELS.filter((m) => liveCatalog.has(m.id))
    : AVAILABLE_MODELS;

  const models = curated.some((m) => m.id === DEFAULT_MODEL)
    ? curated
    : [{ id: DEFAULT_MODEL, label: `${DEFAULT_MODEL} (from .env)` }, ...curated];

  // If the catalog fetch never succeeded, we have no capability data — default
  // to false (hide the upload button) rather than guess a model can take images.
  const withCapabilities = models.map((m) => ({
    ...m,
    supportsImages: liveCatalog?.get(m.id)?.supportsImages === true,
  }));
  res.json({ ok: true, models: withCapabilities, default: DEFAULT_MODEL });
});

app.get('/api/agents', requireAuth, (req, res) => {
  res.json({ ok: true, agents: AVAILABLE_AGENTS, default: AVAILABLE_AGENTS[0].id });
});

// Generates a short sidebar title from a chat's first exchange, once, instead
// of the sidebar just showing the truncated first message forever. Takes
// plain-text summaries of the two messages rather than the raw (possibly
// attachment-laden) message objects, since a title has no need to re-upload
// an image or a PDF just to name the conversation.
app.post('/api/generate-title', requireAuth, async (req, res) => {
  const { userMessage, assistantMessage, agent } = req.body || {};
  if (typeof userMessage !== 'string' || typeof assistantMessage !== 'string') {
    return res.status(400).json({ ok: false, error: 'userMessage and assistantMessage are required' });
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ ok: false, error: 'Server is missing OPENROUTER_API_KEY' });
  }

  // A soccer-lineup thread's messages can carry real player names — this
  // titling call is its own outbound AI request, so it needs the same
  // scrubbing the chat flow itself gets. If the roster can't be read, or a
  // mentioned name is ambiguous, fall back to a generic placeholder rather
  // than risk sending a name through unscrubbed.
  let titleUserText = userMessage;
  let titleAssistantText = assistantMessage;
  if (agent === soccerLineup.AGENT_ID) {
    let roster = null;
    try {
      roster = soccerLineup.loadRoster(req.session.username);
    } catch {
      roster = null;
    }
    if (roster) {
      const ctx = soccerPrivacy.buildAnonymizationContext(roster);
      const scrubbedUser = soccerPrivacy.scrubText(userMessage, ctx);
      const scrubbedAssistant = soccerPrivacy.scrubText(assistantMessage, ctx);
      titleUserText = scrubbedUser.ambiguousNames.size === 0 ? scrubbedUser.text : '(soccer roster update)';
      titleAssistantText = scrubbedAssistant.ambiguousNames.size === 0 ? scrubbedAssistant.text : '(soccer roster update)';
    } else {
      titleUserText = '(soccer roster update)';
      titleAssistantText = '(soccer roster update)';
    }
  }

  try {
    const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.APP_URL || `http://localhost:${PORT}`,
        'X-Title': 'Simple LLM Chat',
      },
      body: JSON.stringify({
        model: TITLE_MODEL,
        messages: [
          {
            role: 'system',
            content:
              'Generate a short title (3-6 words) that summarizes this chat. ' +
              'Reply with only the title itself — no quotes, no punctuation at the end, no explanation.',
          },
          {
            role: 'user',
            content: `User: ${titleUserText.slice(0, 500) || '(sent an attachment)'}\nAssistant: ${titleAssistantText.slice(0, 500)}`,
          },
        ],
        max_tokens: 20,
        stream: false,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!upstream.ok) {
      return res.status(upstream.status).json({ ok: false, error: 'Title generation failed' });
    }

    const data = await upstream.json();
    addUsage(req.session, data?.usage);
    let title = data?.choices?.[0]?.message?.content?.trim() || '';
    title = title.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').replace(/[.!?]+$/, '');
    if (title.length > 80) title = title.slice(0, 80);
    if (!title) {
      return res.status(502).json({ ok: false, error: 'Title generation returned nothing' });
    }

    res.json({ ok: true, title });
  } catch (err) {
    res.status(502).json({ ok: false, error: 'Failed to reach OpenRouter' });
  }
});

// Both the Soccer Lineup agent (lib/soccerLineupChat.js) and the export_file
// tool for the General Assistant (lib/exportChat.js) are two-call
// tool-calling flows, kept in their own modules per CLAUDE.md's file-size
// guidance rather than growing this file further.
app.post('/api/chat', requireAuth, async (req, res) => {
  const { messages, model, responseLength, agent } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ ok: false, error: 'messages array is required' });
  }
  const selectedModel = VALID_MODEL_IDS.has(model) ? model : DEFAULT_MODEL;
  const selectedAgent = VALID_AGENT_IDS.has(agent) ? agent : AVAILABLE_AGENTS[0].id;
  const maxTokens = Object.prototype.hasOwnProperty.call(RESPONSE_LENGTH_TOKENS, responseLength)
    ? RESPONSE_LENGTH_TOKENS[responseLength]
    : RESPONSE_LENGTH_TOKENS[DEFAULT_RESPONSE_LENGTH];

  const facts = loadFacts();
  const upstreamMessages = facts ? [{ role: 'system', content: facts }, ...messages] : messages;

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ ok: false, error: 'Server is missing OPENROUTER_API_KEY' });
  }
  const appUrl = process.env.APP_URL || `http://localhost:${PORT}`;
  const toolChatArgs = {
    upstreamMessages,
    selectedModel,
    maxTokens,
    apiKey,
    username: req.session.username,
    appUrl,
    session: req.session,
  };

  if (selectedAgent === soccerLineup.AGENT_ID) {
    try {
      return await handleSoccerLineupChat(res, toolChatArgs);
    } catch (err) {
      if (!res.headersSent) {
        return res.status(502).json({ ok: false, error: 'Failed to reach OpenRouter' });
      }
      return res.end();
    }
  }

  if (exportChat.looksLikeExportRequest(messages[messages.length - 1]?.content)) {
    try {
      return await exportChat.handleExportAwareChat(res, toolChatArgs);
    } catch (err) {
      if (!res.headersSent) {
        return res.status(502).json({ ok: false, error: 'Failed to reach OpenRouter' });
      }
      return res.end();
    }
  }

  try {
    const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': appUrl,
        'X-Title': 'Simple LLM Chat',
      },
      body: JSON.stringify({
        model: selectedModel,
        messages: upstreamMessages,
        stream: true,
        include_reasoning: true,
        ...(maxTokens != null ? { max_tokens: maxTokens } : {}),
      }),
    });

    if (!upstream.ok) {
      const data = await upstream.json().catch(() => ({}));
      return res
        .status(upstream.status)
        .json({ ok: false, error: data?.error?.message || 'OpenRouter request failed' });
    }

    await pipeUpstreamStream(upstream, res, { onUsage: (u) => addUsage(req.session, u) });
  } catch (err) {
    if (!res.headersSent) {
      res.status(502).json({ ok: false, error: 'Failed to reach OpenRouter' });
    } else {
      res.end();
    }
  }
});

// Direct/testing entry point for file export — same JSON shape as the
// export_file tool's arguments (see lib/export.js). The chat flow above
// reaches generateExport()/storeExport() through lib/exportChat.js instead,
// so the generated file can be handed back as a link inside the
// conversation rather than as this endpoint's raw response body.
app.post('/api/export', requireAuth, async (req, res) => {
  if (!exportStore.checkExportRateLimit(req.session.username)) {
    return res.status(429).json({ ok: false, error: 'Too many export requests — try again in a minute.' });
  }
  try {
    const generated = await exportLib.generateExport(req.body);
    res.setHeader('Content-Type', generated.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${generated.filename}.${generated.extension}"`);
    res.send(generated.buffer);
  } catch (err) {
    if (err instanceof exportLib.ExportValidationError) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    res.status(500).json({ ok: false, error: 'Failed to generate the file.' });
  }
});

// Serves a file generated by the export_file tool. Files live only in
// memory for 15 minutes (lib/exportStore.js) — a stale link past that point
// is a 404, not a dangling file on disk.
app.get('/api/files/:id', requireAuth, (req, res) => {
  const entry = exportStore.getExport(req.params.id);
  if (!entry) {
    return res.status(404).json({ ok: false, error: 'File not found or expired.' });
  }
  res.setHeader('Content-Type', entry.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${entry.filename}.${entry.extension}"`);
  res.send(entry.buffer);
});

// The roster panel's REST API and the lineup draft/finalization REST API
// (no LLM involved anywhere in either) live in their own modules per
// CLAUDE.md's file-size guidance.
app.use('/api/soccer', soccerRosterRoutes);
app.use('/api/soccer', soccerLineupRoutes);

// Ensures the private roster directory exists and migrates any legacy
// data/rosters/*.json into it (see lib/rosterMigration.js) before the
// server starts accepting requests. A misconfigured RAYGPT_DATA_DIR that
// resolves inside this repo is a hard startup failure, not a warning —
// private data must never land somewhere a git operation could pick it up.
try {
  const migrationSummary = soccerLineup.initRosterStorage();
  const { migrated, conflicts, skippedInvalid, errors } = migrationSummary;
  if (migrated.length) console.log(`Roster migration: moved ${migrated.length} file(s) to the private data directory.`);
  if (conflicts.length) console.warn(`Roster migration: ${conflicts.length} file(s) already exist at the destination and differ — resolve manually: ${conflicts.join(', ')}`);
  if (skippedInvalid.length) console.warn(`Roster migration: ${skippedInvalid.length} legacy file(s) were not valid roster JSON and were left in place: ${skippedInvalid.join(', ')}`);
  if (errors.length) console.warn(`Roster migration: ${errors.length} file(s) could not be migrated: ${errors.map((e) => `${e.file} (${e.reason})`).join(', ')}`);
  soccerLineupHistory.initLineupHistoryStorage();
} catch (err) {
  if (err instanceof PrivateDataConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
