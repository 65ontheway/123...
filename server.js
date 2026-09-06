require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
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

// Serve the two browser-ready bundles used to render Markdown in the chat UI
// directly from node_modules, so the page isn't dependent on a third-party CDN.
app.get('/vendor/marked.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules/marked/lib/marked.umd.js'));
});
app.get('/vendor/dompurify.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules/dompurify/dist/purify.min.js'));
});

// Curated high-power open-weight models available through OpenRouter. The
// first entry is a fixed mid-range model labeled as the default (not
// OpenRouter's own dynamic auto-router) — the sensible choice for anything
// that isn't a heavy question; the rest are flagship-tier options for when
// more firepower is wanted.
const AVAILABLE_MODELS = [
  { id: 'qwen/qwen3.8-27b', label: 'Qwen3.8 27B (Default)' },
  { id: 'qwen/qwen3.8-max-0902', label: 'Qwen3.8 Max' },
  { id: 'z-ai/glm-5.3', label: 'GLM-5.3' },
  { id: 'deepseek/deepseek-r1', label: 'DeepSeek R1' },
  { id: 'moonshotai/kimi-k2.6', label: 'Kimi K2.6' },
  { id: 'google/gemma-4-31b-it', label: 'Gemma 4 31B' },
];
const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || AVAILABLE_MODELS[0].id;
const VALID_MODEL_IDS = new Set([...AVAILABLE_MODELS.map((m) => m.id), DEFAULT_MODEL]);

// OpenRouter periodically deprecates/removes models. Rather than let a dead entry
// sit in the dropdown until someone hits "No endpoints found", cross-check the
// curated list against OpenRouter's live catalog and quietly drop anything that's
// disappeared. Cached, and fails open to the full curated list if the catalog
// fetch doesn't succeed, so a network hiccup never breaks the model picker.
let modelCatalogCache = { ids: null, fetchedAt: 0 };
const MODEL_CATALOG_TTL_MS = 60 * 60 * 1000; // 1 hour

async function getLiveModelIds() {
  const now = Date.now();
  if (modelCatalogCache.ids && now - modelCatalogCache.fetchedAt < MODEL_CATALOG_TTL_MS) {
    return modelCatalogCache.ids;
  }
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return modelCatalogCache.ids;
    const data = await res.json();
    if (!Array.isArray(data?.data)) return modelCatalogCache.ids;
    const ids = new Set(data.data.map((m) => m.id));
    modelCatalogCache = { ids, fetchedAt: now };
    return ids;
  } catch {
    return modelCatalogCache.ids;
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
  const liveIds = await getLiveModelIds();
  const curated = liveIds ? AVAILABLE_MODELS.filter((m) => liveIds.has(m.id)) : AVAILABLE_MODELS;

  const models = curated.some((m) => m.id === DEFAULT_MODEL)
    ? curated
    : [{ id: DEFAULT_MODEL, label: `${DEFAULT_MODEL} (from .env)` }, ...curated];
  res.json({ ok: true, models, default: DEFAULT_MODEL });
});

app.post('/api/chat', requireAuth, async (req, res) => {
  const { messages, model } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ ok: false, error: 'messages array is required' });
  }
  const selectedModel = VALID_MODEL_IDS.has(model) ? model : DEFAULT_MODEL;

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
