require('dotenv').config({ path: process.env.DOTENV_CONFIG_PATH || '.env' });

const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const privateData = require('./lib/privateData');
const soccerLineup = require('./lib/soccerLineup');
const { pipeUpstreamStream } = require('./lib/sse');
const { handleSoccerLineupChat } = require('./lib/soccerLineupChat');
const exportLib = require('./lib/export');
const exportStore = require('./lib/exportStore');
const exportChat = require('./lib/exportChat');
const auth = require('./lib/auth');
const { addUsage } = require('./lib/tokenUsage');
const soccerPrivacy = require('./lib/soccerPrivacy');
const soccerRosterRoutes = require('./lib/soccerRosterRoutes');
const soccerLineupRoutes = require('./lib/soccerLineupRoutes');
const soccerLineupHistory = require('./lib/soccerLineupHistory');

const { safeguards, loginLimit } = require('./lib/security');
const { providerFetch, requestScope } = require('./lib/provider');
const { bindConversation } = require('./lib/conversationPolicy');
const { operations } = require('./lib/operations');
const { validateMessages } = require('./lib/validation');
const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY.split(',').map(x => x.trim()));
app.use(safeguards);
const PORT = process.env.PORT || 3000;

// Keep attachment-bearing chat/export requests separate from small control bodies.
const smallJson = express.json({ limit: '16kb' });
const chatJson = express.json({ limit: '3mb' });
app.use((req, res, next) => (['/api/chat', '/api/export'].includes(req.path) ? chatJson : smallJson)(req, res, next));
// File-based, not the default in-memory MemoryStore: a session must survive
// a server restart/redeploy (a coach shouldn't be logged out every time a
// fix ships) and MemoryStore leaks without bound under sustained traffic.
// Lives under the same private data directory as roster/lineup data — same
// persistent volume in a real deployment, same "never in the git repo"
// guarantee, no separate backup/retention story to set up.
const sessionsDir = path.join(privateData.resolvePrivateDataDir(), 'sessions');
privateData.ensurePrivateDir(sessionsDir);
const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 4; // 4 hours
app.use(
  session({
    store: new FileStore({ path: sessionsDir, ttl: SESSION_MAX_AGE_MS / 1000, retries: 0, logFn: () => {} }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: 'auto',
      maxAge: SESSION_MAX_AGE_MS,
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
  { id: 'deepseek/deepseek-v4-flash-0731', label: 'Deepseek v4 0731'},
  { id: 'xiaomi/mimo-v2.5', label: 'Mimo v2.5'},
];
const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || 'qwen/qwen3.8-27b';
const VALID_MODEL_IDS = new Set([...AVAILABLE_MODELS.map((m) => m.id), DEFAULT_MODEL]);

// Every response length has an explicit output cap, including Long.
const RESPONSE_LENGTH_TOKENS = { short: 500, medium: 1000, long: 4000 };
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
const FACTS_FILE = path.resolve(__dirname, process.env.FACTS_FILE || 'facts.md');
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

const { requireAuth } = auth;

app.get('/', (req, res) => {
  if (auth.isAuthenticated(req)) return res.redirect('/chat');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/api/login', loginLimit, async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    const before = auth.identity();
    if (!auth.credentialsMatch(username, process.env.APP_USERNAME) || !await auth.verifyPassword(password)) {
      return res.status(401).json({ ok: false, error: 'Invalid username or password.' });
    }
    const account = auth.identity();
    if (before.version !== account.version) return res.status(401).json({ ok: false, error: 'Credentials changed. Please sign in again.' });
    await new Promise((resolve, reject) => req.session.regenerate(err => err ? reject(err) : resolve()));
    Object.assign(req.session, { loggedIn: true, username: account.username, ownerId: account.ownerId, authVersion: account.version });
    await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.post('/api/logout', (req, res, next) => {
  req.session.destroy(err => {
    if (err) return next(err);
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

app.get('/chat', (req, res) => {
  if (!auth.isAuthenticated(req)) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'views', 'chat.html'));
});

app.get('/profile', (req, res) => {
  if (!auth.isAuthenticated(req)) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'views', 'profile.html'));
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ ok: true, username: req.session.username, ownerId: req.session.ownerId });
});

app.get('/api/session-usage', requireAuth, (req, res) => {
  res.json({ ok: true, usage: req.session.tokenUsage || { promptTokens: 0, completionTokens: 0, totalTokens: 0 } });
});

app.post('/api/change-password', requireAuth, loginLimit, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!await auth.verifyPassword(currentPassword)) return res.status(401).json({ ok: false, error: 'Current password is incorrect.' });
    if (!auth.validPassword(newPassword)) return res.status(400).json({ ok: false, error: 'Use at least 12 characters and at most 1024 bytes.' });
    await auth.setPassword(newPassword);
    req.session.destroy(err => {
      if (err) return next(err);
      res.clearCookie('connect.sid');
      res.json({ ok: true, signInRequired: true });
    });
  } catch (err) { next(err); }
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

app.post('/api/confirm/:id', requireAuth, require('./lib/confirmations').confirm);

app.get('/api/agents', requireAuth, (req, res) => {
  res.json({ ok: true, agents: AVAILABLE_AGENTS, default: AVAILABLE_AGENTS[0].id });
});

// Generates a short sidebar title from a chat's first exchange, once, instead
// of the sidebar just showing the truncated first message forever. Takes
// plain-text summaries of the two messages rather than the raw (possibly
// attachment-laden) message objects, since a title has no need to re-upload
// an image or a PDF just to name the conversation.
app.post('/api/generate-title', requireAuth, bindConversation, requestScope, async (req, res) => {
  const { userMessage, assistantMessage, agent } = req.body || {};
  if (typeof userMessage !== 'string' || typeof assistantMessage !== 'string') {
    return res.status(400).json({ ok: false, error: 'userMessage and assistantMessage are required' });
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ ok: false, error: 'Server is missing OPENROUTER_API_KEY' });
  }

  if (agent === soccerLineup.AGENT_ID) return res.json({ ok: true, title: 'Soccer lineup' });
  const titleUserText = userMessage;
  const titleAssistantText = assistantMessage;

  try {
    const upstream = await providerFetch('https://openrouter.ai/api/v1/chat/completions', {
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

// Agent handlers own tool execution; all model requests share one bounded scope.
app.post('/api/chat', requireAuth, bindConversation, operations, requestScope, async (req, res) => {
  const { messages, model, responseLength, agent } = req.body || {};
  if (!validateMessages(messages)) {
    return res.status(400).json({ ok: false, error: 'Use up to 100 user/assistant messages, at most 32000 characters per text part and 2 MiB total. Start a new chat if needed.' });
  }
  if (agent && !VALID_AGENT_IDS.has(agent)) return res.status(400).json({ ok: false, error: 'Unsupported agent.' });
  const selectedModel = VALID_MODEL_IDS.has(model) ? model : DEFAULT_MODEL;
  const selectedAgent = VALID_AGENT_IDS.has(agent) ? agent : AVAILABLE_AGENTS[0].id;
  const maxTokens = Object.prototype.hasOwnProperty.call(RESPONSE_LENGTH_TOKENS, responseLength)
    ? RESPONSE_LENGTH_TOKENS[responseLength]
    : RESPONSE_LENGTH_TOKENS[DEFAULT_RESPONSE_LENGTH];

  const facts = selectedAgent === soccerLineup.AGENT_ID || process.env.SEND_STANDING_FACTS !== 'true' ? '' : loadFacts();
  if (facts.length > 16000) return res.status(400).json({ ok: false, error: 'Standing facts exceed 16000 characters. Shorten the configured facts file.' });
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
    ownerId: req.session.ownerId,
    gameId: req.body.gameId,
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
    const upstream = await providerFetch('https://openrouter.ai/api/v1/chat/completions', {
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
        .json({ ok: false, error: 'The AI provider could not complete this request.' });
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
  const entry = exportStore.getExport(req.params.id, req.session.ownerId);
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
app.use('/api/soccer', requireAuth, require('./lib/soccerApiValidation').validateSoccer, operations);
app.use('/api/soccer', soccerRosterRoutes);
app.use('/api/soccer', soccerLineupRoutes);

app.use((err, req, res, next) => {
  if (res.headersSent) return res.end();
  const status = err.type === 'entity.too.large' ? 413 : err instanceof SyntaxError ? 400 : 500;
  res.status(status).json({ ok: false, error: status === 413 ? 'Request is too large.' : status === 400 ? 'Invalid JSON request.' : 'The operation failed. Please try again.' });
});

async function start() {
  await auth.initialize();
  const summary = soccerLineup.initRosterStorage();
  if (summary.conflicts.length || summary.errors.length) console.warn('Roster migration needs attention; existing files were preserved.');
  soccerLineupHistory.initLineupHistoryStorage();
  return app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
}
if (require.main === module) start().catch(err => {
  console.error(err instanceof auth.AuthConfigurationError ? err.message : 'Startup failed. Check private storage configuration. Production requires a persistent session store.');
  process.exitCode = 1;
});
module.exports = { app, start };
