# Login + LLM Chat

A minimal app: a login page gates access to a chat page that talks to an LLM
through [OpenRouter](https://openrouter.ai/). A small Express server holds the
OpenRouter API key and validates the login server-side, so the key is never
exposed to the browser.

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env`:

- `OPENROUTER_API_KEY` — your key from https://openrouter.ai/keys
- `OPENROUTER_MODEL` — any OpenRouter model slug (defaults to `openai/gpt-4o-mini`)
- `APP_USERNAME` / `APP_PASSWORD` — the login credentials
- `SESSION_SECRET` — any long random string
- `PORT` — defaults to 3000

## Run

```bash
npm start
```

Open http://localhost:3000, log in, and you're redirected to `/chat`.

## How it works

- `public/login.html` — login form, posts to `POST /api/login`.
- `server.js` — validates credentials against `APP_USERNAME`/`APP_PASSWORD`,
  stores a session cookie, serves `views/chat.html` only to authenticated
  sessions, and proxies `POST /api/chat` to OpenRouter's
  `/chat/completions` endpoint using the server-side API key.
- `views/chat.html` — chat UI; keeps the running conversation in memory and
  sends the full message history to `/api/chat` on each turn.
