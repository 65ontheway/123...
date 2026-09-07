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
- `APP_USERNAME` / `APP_PASSWORD` — the login credentials. `APP_PASSWORD` is
  only the *initial* password — changing it from the profile screen (see
  below) stores a hashed replacement in `data/auth.json` instead, and that
  file takes over from then on. The username can't be changed from the app.
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
- **Agent** — **General Assistant** is the plain chat flow (it can also
  export files — see below). **Soccer Lineup** is a real tool-calling
  agent — see below.

## Soccer Lineup agent

Select **Soccer Lineup** from the Agent dropdown and describe what you want
in plain English — e.g. "Rest Emma the first half, put Sarah at forward in
the third quarter." The model doesn't schedule the game itself: it only
turns your request into structured, per-quarter constraints (formation,
who's resting each quarter, who's pinned to a position each quarter), and
the app schedules all 4 quarters deterministically. That split exists
because an LLM asked to fill 7 slots x 4 quarters — while also enforcing
AYSO's fairness rule below — will drift on that bookkeeping as the roster
grows; the actual scheduling is plain code, not a guess.

**AYSO fairness rule, enforced by code, not the model:** every player plays
3 quarters before anyone plays a 4th. Each quarter's open slots are filled
by whoever has played the fewest quarters so far (skill rating is only the
tiebreaker), which naturally produces this distribution. If an explicit
request you make (e.g. pinning the same player to a position across
multiple quarters) would force someone into a 4th quarter early, the
response says so explicitly rather than silently violating the rule or
silently overriding your request.

### Managing the roster from chat

You don't need to hand-edit a file to get started or to keep the roster up
to date — just tell the agent in plain English, e.g. "add Sarah, she's a 4
offense, 2 defense, 1 goalie", "bump Emma's defense to a 4", or "remove
Jenny, she moved away." As with scheduling, the model only extracts what
changed; the app applies the add/update/remove to the roster file itself,
so a rating never gets silently mis-typed by the model. Ratings you don't
mention default to **3** on a new player. A brand-new account has no
roster file yet — asking the agent to add players creates one
automatically, so there's no setup step required before your first
message.

You can still hand-edit the file directly if you prefer:

```bash
mkdir -p data/rosters
cp roster.json.example data/rosters/<your-login-username>.json
```

The filename must match the username you log in with (e.g. `admin.json` if
`APP_USERNAME=admin`) — rosters are isolated per account so player data is
never shared between logins, even though today there's only the one
account. Edit it with your real roster — a `formation` (see the four
supported below) and a `players` array, each with a `name` and a `skills`
object rating them **1-5** on `offense`, `defense`, and `goalie`. A
midfielder's fit for a slot is scored as the average of `offense` and
`defense`, since that position plays both ways. Like `facts.md`, everything
under `data/rosters/` is git-ignored (it's real kids' names and stats) and
re-read automatically when it changes — no restart needed.

Supported 7v7 formations: `2-3-1` (default), `3-2-1`, `2-2-2`, `3-1-2`. Set
one as your roster file's default or name one per request ("set the lineup
in a 3-2-1"). If a request can't be fully satisfied (an unrecognized name,
two players pinned to the same slot in the same quarter, more players
resting than the roster can cover), the response explains what happened
instead of silently guessing.

## File export

Ask the **General Assistant** to export something — "export this as a Word
document", "give me a PDF", "save that table as a CSV" — and it generates a
real file server-side and adds a small download link (⬇️) at the bottom of
that one reply. It's never a persistent per-message button: the link only
appears on the specific response that produced a file.

Supported formats: `txt`, `csv`, `pdf`, `docx`, `xlsx` (including multiple
named sheets). As with the other tools, the model never generates the file
itself — it only decides the format, filename, and content/rows; a plain
Node function (`lib/export.js`) builds the actual file with free,
open-source libraries (`pdfkit` with standard fonts only, `docx`, and the
`exceljs` already used for spreadsheet attachments — no paid/licensed
SDKs). For `pdf`/`docx`, a small built-in Markdown subset (`#` headings,
`**bold**`, `-`/`*` bullets, paragraphs) is rendered into the document;
anything fancier in the source Markdown just falls back to a plain
paragraph rather than failing.

Generated files aren't attached inline — they're held in memory for **15
minutes** behind a short-lived `/api/files/:id` link, then discarded (never
written to disk, never kept indefinitely). If you reopen an old chat after
that window, the download chip is still there (it's part of the saved
thread), but the link itself will 404 — export again to get a fresh one.
Export requests are also rate-limited to 10/minute per account.

Offering the export tool on every single message would mean an extra,
non-streaming round trip before any reply could start — paid by every
message just to catch the rare export request. Instead, `lib/exportChat.js`
only offers the tool when the message plausibly asks for a file (a cheap
keyword check for words like "export", "download", "pdf", "csv", "excel",
"word doc", etc.); everything else keeps the normal single streaming call,
with no added latency. The model is still the real decision-maker on
whether to actually call the tool — a passing mention of "PDF" won't
produce a file, it just clears the cheap filter that decides whether to
offer the option at all.

**Testing `/api/export` directly** (the same JSON shape the model's tool
call uses; requires being logged in — pass your session cookie jar):

```bash
# Log in first to get a session cookie
curl -c cookies.txt -X POST http://localhost:3000/api/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"changeme"}'

# txt
curl -b cookies.txt -X POST http://localhost:3000/api/export \
  -H 'Content-Type: application/json' \
  -d '{"format":"txt","filename":"notes","content":"Hello world"}' \
  -o notes.txt

# csv
curl -b cookies.txt -X POST http://localhost:3000/api/export \
  -H 'Content-Type: application/json' \
  -d '{"format":"csv","filename":"scores","headers":["Name","Score"],"rows":[["Sarah",5],["Emma",4]]}' \
  -o scores.csv

# pdf (Markdown body)
curl -b cookies.txt -X POST http://localhost:3000/api/export \
  -H 'Content-Type: application/json' \
  -d '{"format":"pdf","filename":"report","title":"Report","markdown":"# Heading\n\n**Bold** text.\n\n- one\n- two"}' \
  -o report.pdf

# docx (Markdown body)
curl -b cookies.txt -X POST http://localhost:3000/api/export \
  -H 'Content-Type: application/json' \
  -d '{"format":"docx","filename":"doc","markdown":"# Title\n\nSome text."}' \
  -o doc.docx

# xlsx (multiple sheets)
curl -b cookies.txt -X POST http://localhost:3000/api/export \
  -H 'Content-Type: application/json' \
  -d '{"format":"xlsx","filename":"multi","sheets":[{"name":"One","headers":["X"],"rows":[[1]]},{"name":"Two","rows":[[2]]}]}' \
  -o multi.xlsx
```

## Profile settings

Your username appears as a button in the header, next to the model picker —
click it to open `/profile`:

- **Session token usage** — prompt/completion/total tokens used by your
  OpenRouter calls since you logged in (every call across all three chat
  flows counts, including the hidden first call in a tool-calling agent's
  two-call flow, and the title-generation call). This resets when your
  login session ends; it's not a running lifetime total, and it's not
  per-account cost tracking — just a quick sense of how much a session used.
- **Clear history** — permanently deletes every chat thread stored in this
  browser (with a confirmation first, since it can't be undone). This is
  purely local: threads have never lived server-side, so this doesn't touch
  the roster or any other account data.
- **Change password** — the current app has just the one hardcoded account
  from `.env`, so this doesn't create new accounts or touch the username;
  it only replaces the password check. Requires your current password,
  hashes the new one (Node's built-in `crypto.scrypt`, salted, never stored
  in plaintext), and writes it to `data/auth.json` — git-ignored, same
  pattern as `roster.json`/`facts.md`. Until you change it for the first
  time, login still falls back to `APP_PASSWORD` from `.env`, so existing
  setups need no migration step.

Account deletion isn't in here — with only one hardcoded account today,
"deleting" it doesn't have an obvious meaning yet; that's a better fit once
real multi-account support exists.

## Auto-generated chat titles

New chats are titled from the truncated first message at first, but once the
first exchange finishes, the server asks a cheap/fast model
(`deepseek/deepseek-v3.2`) for a real 3-6 word title and swaps it in. This
happens once per chat — if it fails (network issue, etc.) the truncated
title just stays as-is rather than retrying on every later message.

## How it works

- `public/login.html` — login form, posts to `POST /api/login`.
- `server.js` — validates credentials (username against `APP_USERNAME`,
  password via `lib/auth.js`), stores a session cookie, serves
  `views/chat.html`/`views/profile.html` only to authenticated sessions,
  and proxies `POST /api/chat` to OpenRouter's `/chat/completions` endpoint
  using the server-side API key.
- `views/chat.html` — chat page markup only. Served exclusively through the
  authenticated `GET /chat` route.
- `views/profile.html` — the profile screen markup, served through the
  authenticated `GET /profile` route.
- `public/css/` — styling, one file per UI area: `base.css` (shared theme
  tokens/reset, used by both pages), `header.css` (shared by both pages'
  headers), `sidebar.css`, `messages.css` (chat transcript + empty state),
  `composer.css`, `profile.css`.
- `public/js/` — client logic as real ES modules (loaded via
  `<script type="module">`, no build step), one per concern:
  - `state.js` — thread data, localStorage persistence, thread lifecycle
  - `settings.js` — model/agent catalog, response-length, image capability
  - `sidebar.js` — thread list UI, rename, resize, mobile drawer
  - `attachments.js` — staging/extracting images, PDFs, Word/Excel; the
    attach menu; paste-to-attach
  - `messages.js` — rendering bubbles, Markdown, the empty-state cards, and
    the export download chip
  - `chat.js` — the chat page's entry point: composer send/streaming flow
    and bootstrap; the only file that imports from all the chat-page modules
  - `profile.js` — the profile page's entry point. Deliberately
    self-contained rather than importing `state.js`, since that module's
    dependency chain (`sidebar.js`, `attachments.js`) wires up listeners on
    chat.html-only elements at load time, which would throw on this page.

  Like everything else in `public/`, all of these are served unauthenticated
  (there's nothing sensitive in them — the API key never leaves the server),
  the same way `/vendor/*.js` already are.
- `lib/soccerLineup.js` / `lib/soccerLineupChat.js` — the Soccer Lineup
  agent's domain logic (roster file I/O, the two tool definitions, the
  deterministic 4-quarter scheduling algorithm) and its chat-handling
  respectively, split into two files since the domain logic is worth
  testing on its own.
- `lib/export.js` / `lib/exportStore.js` / `lib/exportChat.js` — the file
  export feature: the `export_file` tool definition and actual file
  generation (txt/csv/pdf/docx/xlsx), the in-memory temporary file store +
  rate limiter, and the keyword-gated chat-handling respectively.
- `lib/auth.js` — password hashing/verification for the single hardcoded
  account (see Profile settings above).
- `lib/tokenUsage.js` — accumulates each OpenRouter response's `usage` onto
  the login session, for the profile screen's token-usage display.
- `lib/sse.js` — the SSE passthrough shared by the plain chat flow and
  every agent's explanatory (post-tool-call) streamed reply. Reconstructs
  the stream line-by-line (rather than forwarding raw bytes) so it can
  optionally observe each chunk's `usage` field and/or inject one extra
  chunk (used by the export flow to attach download metadata) without
  changing what the client receives.
