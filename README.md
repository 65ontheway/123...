# Login + LLM Chat

A minimal app: a login page gates access to a chat page that talks to an LLM
through [OpenRouter](https://openrouter.ai/). A small Express server holds the
OpenRouter API key and validates the login server-side, so the key is never
exposed to the browser.

## Setup

```bash
npm install
cp .env.example .env
cp facts.md.example facts.md
```

Edit `.env`:

- `OPENROUTER_API_KEY` — your key from https://openrouter.ai/keys
- `OPENROUTER_MODEL` — any OpenRouter model slug (defaults to `qwen/qwen3.8-27b`, labeled "Qwen3.8 27B (Default)" in the picker); this is just the server's default — the chat page also has a model picker
- `APP_USERNAME` / `APP_PASSWORD` — the login credentials
- `SESSION_SECRET` — any long random string
- `PORT` — defaults to 3000
- `FACTS_FILE` — optional, defaults to `facts.md` (see below)

## Run

```bash
npm start
```

Open http://localhost:3000, log in, and you're redirected to `/chat`.

## Standing facts (`facts.md`)

Anything in `facts.md` is sent to the model as a system message on every
request, regardless of which model is selected. Edit and save the file any
time — the server re-reads it automatically (checked on every request via its
last-modified time), no restart needed. Keep it short: it's included, and
billed, on every single message.

`facts.md` is git-ignored (it's easy to end up putting personal details in
it), so it's not part of the repo. Copy `facts.md.example` to `facts.md` and
fill in your own — same pattern as `.env.example`/`.env`. Only what actually
belongs in the prompt should go here; usage notes belong in this README, not
the file itself, since the whole file is sent to the model verbatim.

To use a different file or location, set `FACTS_FILE` in `.env` to a path
relative to the project root.

## Attachments

The composer has a single 📎 attach button that opens a small menu:

- **Upload image / take photo** — only shown when the currently selected
  model can actually see images (checked via OpenRouter's live catalog, the
  same data already used to prune dead models from the picker). Switching to
  a model that doesn't support images clears any image you'd already
  attached. Attached images are downscaled to at most 1280px on the long
  edge and re-encoded as JPEG in the browser before sending, to keep
  requests small.
- **Upload file** — a PDF, Word (`.docx`), or Excel (`.xlsx`/`.xls`) file.
  Always available, regardless of which model is selected:
  - PDFs are sent through OpenRouter's own universal PDF parser, which works
    with any model (not just ones with native file support).
  - Word and Excel files have no equivalent API format, so their text is
    extracted right in the browser (via `mammoth` for `.docx`, `exceljs` for
    spreadsheets) and sent as plain text instead of the original file. Legacy
    `.doc` isn't supported — convert it to `.docx` first.

Both kinds of attachments persist in thread history, so re-opening an old
chat shows the same thumbnails/file chips as when they were sent.

You can also skip the menu entirely and just paste (Cmd/Ctrl+V) directly
into the message box — a screenshot, a copied image, or a file copied from
Finder/Explorer. It's routed through the exact same logic as the menu, so
the same rules apply (an image is silently ignored if the selected model
can't see images; a PDF/Word/Excel file works regardless of model).

## Sidebar settings

Below the chat list, the sidebar has two dropdowns (global settings, not
tied to any one chat):

- **Response length** — Short (500 tokens), Medium (1000, default), or Long
  (no cap — bounded only by the model's own limit). Applies to the next
  message sent, from any chat.
- **Agent** — no real agents exist yet; this is the wiring (server endpoint,
  request field, validation) for a feature landing later. Selecting the one
  placeholder entry has no effect today.

## Auto-generated chat titles

New chats are titled from the truncated first message at first, but once the
first exchange finishes, the server asks a cheap/fast model
(`deepseek/deepseek-v3.2`) for a real 3-6 word title and swaps it in. This
happens once per chat — if it fails (network issue, etc.) the truncated
title just stays as-is rather than retrying on every later message.

## How it works

- `public/login.html` — login form, posts to `POST /api/login`.
- `server.js` — validates credentials against `APP_USERNAME`/`APP_PASSWORD`,
  stores a session cookie, serves `views/chat.html` only to authenticated
  sessions, and proxies `POST /api/chat` to OpenRouter's
  `/chat/completions` endpoint using the server-side API key.
- `views/chat.html` — chat page markup only. Served exclusively through the
  authenticated `GET /chat` route.
- `public/chat.css` / `public/chat.js` — the chat page's styling and client
  logic (thread state, streaming, attachments, etc.), split out of the HTML
  file into their own files. Like everything else in `public/`, these are
  served unauthenticated (there's nothing sensitive in them — the API key
  never leaves the server), the same way `/vendor/*.js` already are.
