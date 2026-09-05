require('dotenv').config();

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

const AVAILABLE_MODELS = [
  { id: 'openai/gpt-4o-mini', label: 'GPT-4o mini' },
  { id: 'openai/gpt-4o', label: 'GPT-4o' },
  { id: 'anthropic/claude-3.5-sonnet', label: 'Claude 3.5 Sonnet' },
  { id: 'google/gemini-2.0-flash-001', label: 'Gemini 2.0 Flash' },
  { id: 'qwen/qwen3.8-27b', label: 'Qwen3.8 27B' },
  { id: 'qwen/qwen3.8-max-0902', label: 'Qwen3.8 Max' },
  { id: 'meta-llama/llama-3.1-8b-instruct:free', label: 'Llama 3.1 8B (free)' },
];
const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || AVAILABLE_MODELS[0].id;
const VALID_MODEL_IDS = new Set([...AVAILABLE_MODELS.map((m) => m.id), DEFAULT_MODEL]);

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

app.get('/api/models', requireAuth, (req, res) => {
  const models = AVAILABLE_MODELS.some((m) => m.id === DEFAULT_MODEL)
    ? AVAILABLE_MODELS
    : [{ id: DEFAULT_MODEL, label: `${DEFAULT_MODEL} (from .env)` }, ...AVAILABLE_MODELS];
  res.json({ ok: true, models, default: DEFAULT_MODEL });
});

app.post('/api/chat', requireAuth, async (req, res) => {
  const { messages, model } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ ok: false, error: 'messages array is required' });
  }
  const selectedModel = VALID_MODEL_IDS.has(model) ? model : DEFAULT_MODEL;

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
        messages,
        stream: true,
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
