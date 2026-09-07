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
in plain English — e.g. "Rest Emma the first half, put Sarah at left back in
the third quarter." The model doesn't schedule the game itself: it only
turns your request into structured, per-quarter constraints (formation,
who's resting each quarter, who's pinned to an exact position or a general
role each quarter, any left/right side preference for this lineup), and the
app schedules all 4 quarters deterministically. That split exists because an
LLM asked to fill 7 slots x 4 quarters — while also enforcing AYSO's
fairness rule below and left/right side preferences — will drift on that
bookkeeping as the roster grows; the actual scheduling is plain code, not a
guess.

**AYSO fairness rule, enforced by code, not the model:** every player plays
3 quarters before anyone plays a 4th. Each quarter's open slots are filled
by whoever has played the fewest quarters so far (skill rating is only the
tiebreaker), which naturally produces this distribution. If an explicit
request you make (e.g. pinning the same player to a position across
multiple quarters) would force someone into a 4th quarter early, the
response says so explicitly rather than silently violating the rule or
silently overriding your request.

### The roster panel

Click **Roster** in the sidebar (visible whenever **Soccer Lineup** is the
selected agent) to open a slide-over panel listing every player and their
offense/defense/goalie ratings. Add, edit, or remove a player directly here
— none of this goes through the model at all, so a rating can never get
mis-typed or mis-heard by an LLM, and removing a player asks for
confirmation first. The panel shows its own loading/saving/saved/error
states (success is only reported once the server has actually confirmed the
write), and it's keyboard- and mobile-friendly (Escape or a backdrop click
closes it, same as the rest of the app's overlays).

The panel also tells you exactly where your roster is stored — see
"Where roster data lives" below; the wording only ever says "this Mac" when
the server process is actually running on macOS.

A brand-new account has no roster yet; the panel shows an empty state and
lets you add your first player straight away — no setup step or file to
create first.

### Managing the roster from chat

You can also update an existing player through the chat, in plain English —
e.g. "bump Emma's defense to a 4" or "remove Jenny, she moved away." As with
scheduling, the model never sees Emma or Jenny's real name (more on that
below); it only extracts what changed, and the app applies the update to
the roster file itself, so a rating never gets silently mis-typed by the
model.

**Adding a brand-new player always happens through the roster panel, never
through chat.** A chat message that looks like it's trying to introduce a
new name ("add Sarah...", "sign up a new player...") is caught locally and
declined with a pointer to the panel, before anything is sent to the model
— there's no safe way to anonymize a name the app has never seen before, so
the app never tries to guess at one. If a request mentions a name that's
ambiguous (two players share it) or that the app doesn't recognize at all,
you'll get a local clarification request instead of a guess — again, before
any AI call happens.

Supported 7v7 formations: `2-3-1` (default), `3-2-1`, `2-2-2`, `3-1-2`. Set
one as your roster's default in the panel, or name one per request ("set
the lineup in a 3-2-1"). If a request can't be fully satisfied (two players
pinned to the same slot in the same quarter, more players resting than the
roster can cover, a position that doesn't exist in the chosen formation),
the response explains what happened instead of silently guessing or
substituting something else.

### Exact positions and formations

Each formation is a fixed set of exact, named slots — not just "2 defenders,
3 midfielders, 1 forward":

| Formation | Slots |
| --- | --- |
| `2-3-1` (default) | Goalkeeper; Left Back, Right Back; Left Wing, Center Mid, Right Wing; Striker |
| `3-2-1` | Goalkeeper; Left Back, Center Back, Right Back; Left Midfield, Right Midfield; Striker |
| `2-2-2` | Goalkeeper; Left Back, Right Back; Left Midfield, Right Midfield; Left Forward, Right Forward |
| `3-1-2` | Goalkeeper; Left Back, Center Back, Right Back; Center Mid; Left Forward, Right Forward |

Every slot counts as one of four broad roles for skill scoring, unchanged
from before exact positions existed: **Goalkeeper** (scored on `goalie`),
**Defender** (scored on `defense` — includes every back), **Forward**
(scored on `offense` — includes every forward/striker), and **Midfielder**
(scored on the average of `offense`/`defense` — includes every wing, since
a wing plays both ways). A wing is a midfielder with a side; a lone striker
or center slot has no side at all.

You can pin a player either way, and both are useful:

- **An exact slot** — "put Sarah at left back", "Emma plays center mid in
  Q3" — assigns that specific spot. Common aliases work too (`goalie`,
  `keeper`, `center midfield`, `left wing`, etc.).
- **A general role** — "play Sarah in defense" — reserves that role for her
  without picking a side; the app picks the exact slot using your side
  preference (below).

An exact pin always wins a conflict over a general role request, and is
never moved to satisfy a side preference — if you specifically said "left
back," that's where they play, full stop. A position that doesn't exist in
your chosen formation (e.g. "left wing" in a `3-2-1`) is explained back to
you rather than silently swapped for something else.

### Side preferences

When a role has two mirrored slots (e.g. Left Back/Right Back), you can set
a default for which side gets the **lower-average player** — average
meaning `(offense + defense) / 2`, goalie rating never included, since side
preference only ever applies to outfield roles that come in a left/right
pair. Defaults:

| Role | Default |
| --- | --- |
| Defender | Lower-average defender on the **right** |
| Midfielder / wing | Lower-average midfielder/wing on the **left** |
| Forward | No preference |

Set these in the roster panel under **Side preferences** — three plain
selects (Left / Right / No preference), each labeled neutrally (e.g.
"Lower-average defender"), auto-saving the moment you change one; the other
two are never touched. An older roster saved before this setting existed is
given these defaults automatically the next time it's loaded, without
touching anything else already in the file.

Side preference never changes **who plays or for how long** — it only
decides, among two already-selected players in a matching left/right pair,
which one lands on which side. A center slot (Center Back, Center Mid) is
never part of a side comparison. An exact pin on either side of a pair takes
that whole pair out of consideration for the swap; a general role pin can
still be side-assigned. Equal averages, or no preference for that role,
leave the pair exactly as the scheduler's normal ordering already placed
it — no swap at all.

**Temporary vs. saved, from chat:**

- *"For this game, put the weaker defender at left back."* — a **this-lineup-only**
  override; your saved default is untouched.
- *"Ignore side preferences for this lineup."* — disables **all** side
  preferences for this one lineup only.
- *"Make weaker defenders on the left my new default."* — **persists** just
  the defender preference; midfielder and forward stay exactly as they were.
- *"Save these side preferences as my defaults."* — persists whatever was
  just discussed; if it's not clear which role(s)/side(s) "these" means, the
  agent asks you to confirm rather than guessing.

An ordinary lineup request never modifies your saved settings — only an
explicit save/change request does, and a message that does both ("save this
as my default, and set today's lineup") runs both actions, not just the
first one. The lineup response always says which preferences actually
applied and whether each was your saved default or a this-lineup-only
override, so the explanation matches exactly what was scheduled.

**Priority, when several things could apply to the same slot (highest
first):** who's available and how many quarters they've already played
(AYSO fairness, unchanged) → an explicit exact-position or general-role pin
→ a this-lineup-only side override, falling back to your saved default →
stable, deterministic tie-breaking. An explicit pin can still push a player
into a 4th quarter ahead of the AYSO rule (unchanged, existing behavior) —
the response explains that it happened and why, rather than silently
overriding your request or silently enforcing the rule instead. Side
preference can never cause an extra fairness violation on its own, since it
only ever swaps two players who were already both selected to play.

### Where roster data lives

Roster files are **not** stored inside this git repository. They live in a
private, per-user application-data folder outside any project checkout:

| Platform | Default location |
| --- | --- |
| macOS | `~/Library/Application Support/RayGPT/rosters/` |
| Windows | `%APPDATA%\RayGPT\rosters\` |
| Linux | `$XDG_DATA_HOME/RayGPT/rosters/` (or `~/.local/share/RayGPT/rosters/`) |

Override the location with `RAYGPT_DATA_DIR` in `.env` (rosters go in a
`rosters/` subfolder of whatever you set). A relative path resolves against
the directory the server was started from, not the project folder. The
server refuses to start if this resolves to anywhere inside the project
repo — private data isn't allowed to live somewhere it could get committed,
zipped, or backed up as part of the project — and exits with a clear error
telling you to change `RAYGPT_DATA_DIR`.

Each account's roster is one JSON file, named after the login username
(e.g. `admin.json`), so rosters are never shared between accounts. Where
the underlying filesystem supports it, the roster directory and each roster
file are created with restrictive permissions (owner read/write only) and
every save is written atomically (a temp file, then a single rename) so a
crash or a failed write mid-save can never leave a half-written or
corrupted file — the previous save stays intact until a new one fully
succeeds.

**Migrating from the old `data/rosters/` location:** earlier versions of
this app stored rosters inside the project repo, under `data/rosters/`
(already git-ignored, but still inside the checkout). On startup, the
server automatically copies any files found there into the new private
location — the legacy files are only ever copied, never moved or deleted,
and a copy is verified against its source before the app trusts it. If a
file already exists at the destination, it's left alone rather than
overwritten, and startup logs report a mismatch by filename only (never
player names or ratings) so you can resolve it by hand if needed. The
legacy `data/rosters/` path stays git-ignored either way. Once you've
confirmed your roster shows up correctly in the panel, it's safe to delete
the old `data/rosters/` folder — the app never reads from it again except
to check for anything not yet migrated.

**Backups:** since roster data lives outside the repo, it isn't covered by
whatever backs up your git history. Back up the private data directory
above the same way you'd back up any other personal file on your machine.

### What actually gets sent to the AI provider

For every Soccer Lineup request — scheduling, chat-based roster updates, and
the follow-up explanation that comes back afterward — real player names
never leave the server. Before any OpenRouter call, the app builds a
per-request mapping from each player to an opaque label (`Player_1`,
`Player_2`, ...); the current message, the entire replayed conversation
history, the system prompt describing the roster, and every tool call's
arguments and results all go out labeled, never named. The model's reply is
translated back to real names locally, after the response comes back, so
what you see in the chat still reads naturally.

This covers the request in full, not just the latest message — including
older messages replayed for context and the title the app generates for a
new chat. Attachments (images, PDFs, etc.) aren't supported by this agent
at all; a message with one is blocked locally before any AI call, since
there's no safe way to guarantee an attachment doesn't contain something
that shouldn't be anonymized.

**What this doesn't claim:** scheduling information itself (ratings, which
quarter someone rests, formation, exact positions, side preferences) still
leaves the server — an LLM needs *something* to reason about, and none of
that is personally identifying on its own. What's protected is the name.
That protection only covers names already on your roster, matched as whole
words — it can't recognize a name it's never seen before (a typo, a
nickname, someone not yet added), which is part of why adding a new player
is never allowed through chat. And opaque labels aren't a cryptographic
anonymity guarantee on their own — this is a real, meaningful reduction in
what leaves the server, not a claim that the data is unlinkable by a
determined adversary. Server-side logs and error messages for this agent
are also written to avoid real names, for the same reason. Saving a side
preference default never involves a player name or label at all — it's a
plain settings update, handled by its own tool call so an ordinary lineup
request can never accidentally change it.

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
  pattern as `facts.md`. Until you change it for the first
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
  - `roster.js` — the Soccer Lineup roster panel: visibility tied to the
    selected agent, open/close, list rendering, add/edit/remove against the
    roster REST API, the side-preferences selects (auto-saving against
    their own endpoint), and its own loading/saving/saved/error states
  - `chat.js` — the chat page's entry point: composer send/streaming flow
    and bootstrap; the only file that imports from all the chat-page modules
  - `profile.js` — the profile page's entry point. Deliberately
    self-contained rather than importing `state.js`, since that module's
    dependency chain (`sidebar.js`, `attachments.js`) wires up listeners on
    chat.html-only elements at load time, which would throw on this page.

  Like everything else in `public/`, all of these are served unauthenticated
  (there's nothing sensitive in them — the API key never leaves the server),
  the same way `/vendor/*.js` already are.
- `lib/soccerLineup.js` / `lib/soccerFormations.js` / `lib/soccerScheduling.js`
  / `lib/soccerSidePreferences.js` / `lib/soccerLineupChat.js` /
  `lib/soccerPrivacy.js` / `lib/soccerRosterRoutes.js` — the Soccer Lineup
  agent, split by concern: `soccerLineup.js` is roster storage (atomic
  writes, per-account locking, player IDs) and direct player CRUD for the
  panel; `soccerFormations.js` is the position catalog (every formation's
  exact slots, their role/side, alias/token normalization); `soccerScheduling.js`
  is the two scheduling tool schemas and the deterministic 4-quarter,
  position- and side-preference-aware scheduling algorithm itself;
  `soccerSidePreferences.js` is the left/right preference defaults,
  validation, roster migration, and the side-assignment swap step;
  `soccerPrivacy.js` builds the per-request name↔label anonymization used
  on every outbound AI call (see "What actually gets sent to the AI
  provider" above); `soccerLineupChat.js` is the chat-driven tool-calling
  flow that ties those together, including running more than one tool call
  in a single turn; `soccerRosterRoutes.js` is the roster panel's REST API
  (`/api/soccer/roster*`), which never calls the model at all. Split into
  separate files since the domain logic, the position/preference catalog,
  the privacy layer, and the two different entry points (chat vs. panel)
  are each worth testing on their own — see CLAUDE.md's guidance on
  splitting before a file grows past ~500 lines.
- `lib/privateData.js` — resolves where private, per-account data (roster
  files today) lives on disk, outside the git repo; see "Where roster data
  lives" above.
- `lib/rosterMigration.js` — the one-time, non-destructive copy of any
  legacy `data/rosters/*.json` files into the private data directory, run
  at server startup.
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
  changing what the client receives. The Soccer Lineup agent's explanatory
  reply is buffered and de-anonymized as a whole before being sent to the
  browser as one or two chunks, rather than streamed token-by-token like
  every other agent — the trade-off exists because a name label could
  otherwise be split across stream chunks and missed during substitution.

## Tests

```bash
npm test
```

Runs the full suite (`node --test test/*.test.js`, Node's built-in test
runner — no extra test-framework dependency). All fixture data in the test
suite is fictional. Coverage includes:

- `test/privateData.test.js` — private-directory resolution, in-repo
  rejection, atomic writes.
- `test/rosterMigration.test.js` — legacy `data/rosters/` migration:
  clean migration, idempotent re-runs, and a genuine conflict (destination
  never overwritten, legacy original never touched).
- `test/soccerLineup.test.js` — the storage layer (missing vs. invalid vs.
  unreadable rosters, atomic-write failure leaving the previous file
  intact, concurrent writes via the per-account lock, account isolation,
  duplicate-name scheduling resolved by ID).
- `test/soccerFormations.test.js` — the position catalog: every formation
  has exactly 7 unique slots, role-suitability scoring is unchanged,
  formation resolution, position/role token and alias normalization,
  formation-specific validity, and the left/right/center pair groupings
  used for side-assignment (including the three-slot case).
- `test/soccerSidePreferences.test.js` — defaults, backfilling an older
  roster without losing existing data, persisting a partial settings
  update while preserving the rest, the default-vs-temporary-vs-explicit-none
  resolution rules, and the side-assignment swap itself in isolation
  (including exact-pin exclusion, equal-average stability, and the ignored
  center slot).
- `test/soccerScheduling.test.js` — `computeGameLineup` end-to-end for
  every formation: default side placement, exact-position pins honored
  ahead of and never moved by generic role pins or side preferences,
  this-lineup-only overrides (including "ignore all"), a saved default
  picked up automatically, invalid/unrecognized positions and slot
  conflicts explained rather than silently substituted, an exact pin still
  able to override the AYSO fairness rule with a warning (unchanged
  existing behavior), and confirmation that changing only a side
  preference never changes who plays, the bench, or quarters-played totals.
- `test/soccerPrivacy.test.js` — the name/label scrubbing module in
  isolation: whole-word matching, ambiguous shared-name detection, chat-
  based roster edits that never rename a player to their own label, and
  scheduling-argument validation (an unresolvable player reference, an
  invalid quarter, or an invalid side-preference role/value is reported as
  a warning rather than silently dropped).
- `test/soccerPrivacyBoundary.test.js` — the integration-level guarantee:
  monkey-patches the global `fetch` to capture every outbound OpenRouter
  request and asserts no fictional player name ever appears in any of them
  (scheduling requests, replayed history, chat-based updates, exact-position
  pins, and the system prompt), that an attempted add or an ambiguous name
  never reaches the model at all, that roster-panel edits (add/update/remove,
  including saving a side preference) never call the model, that a
  this-lineup-only side override never persists to the roster file, and
  that a single turn asking to both save a new default AND schedule a
  lineup actually runs both tool calls rather than silently processing only
  the first one.
