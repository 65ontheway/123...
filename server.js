require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');

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

// No real agents yet — this is the plumbing (endpoint, validation, request
// wiring) for a feature landing later. The single placeholder entry is a
// no-op today; POST /api/chat already accepts and validates an `agent` field
// so nothing else needs to change when real agents are added.
const AVAILABLE_AGENTS = [{ id: 'default', label: 'General Assistant' }];
const VALID_AGENT_IDS = new Set(AVAILABLE_AGENTS.map((a) => a.id));

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

function credentialsMatch(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA); // keep timing roughly constant
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
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
  const expectedPass = process.env.APP_PASSWORD || 'changeme';

  const valid =
    typeof username === 'string' &&
    typeof password === 'string' &&
    credentialsMatch(username, expectedUser) &&
    credentialsMatch(password, expectedPass);

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

app.post('/api/chat', requireAuth, async (req, res) => {
  const { messages, model, responseLength, agent } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ ok: false, error: 'messages array is required' });
  }
  const selectedModel = VALID_MODEL_IDS.has(model) ? model : DEFAULT_MODEL;
  const selectedAgent = VALID_AGENT_IDS.has(agent) ? agent : AVAILABLE_AGENTS[0].id; // no-op today
  const maxTokens = Object.prototype.hasOwnProperty.call(RESPONSE_LENGTH_TOKENS, responseLength)
    ? RESPONSE_LENGTH_TOKENS[responseLength]
    : RESPONSE_LENGTH_TOKENS[DEFAULT_RESPONSE_LENGTH];

  const facts = loadFacts();
  const upstreamMessages = facts ? [{ role: 'system', content: facts }, ...messages] : messages;

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ ok: false, error: 'Server is missing OPENROUTER_API_KEY' });
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

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value, { stream: true }));
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) {
      res.status(502).json({ ok: false, error: 'Failed to reach OpenRouter' });
    } else {
      res.end();
    }
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
