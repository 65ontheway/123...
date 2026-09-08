# RayGPT cleanup review

Worktree: `/Users/rayminehan/123...`

Branch: `codex/raygpt-cleanup`

Intended review target: `main`

The pre-existing CLAUDE.md edit and untracked .DS_Store are excluded from this
cleanup. No deployment was performed. Real credentials, rosters and
standing-facts contents were not used for verification.

## Changes

- Required account/session configuration, asynchronous scrypt, private atomic
  credential records, session renewal and password-change invalidation.
  Saved credential corruption fails closed; legacy migration preserves originals.
- Deliberate cookie, proxy, origin/JSON CSRF, CSP, framing and private-cache
  policy. Production startup is blocked while MemoryStore remains in use.
- Immutable export ownership and account-scoped browser history. Existing
  unowned history stays hidden and untouched. Agent policy is also bound on
  the server; stale tabs cannot send one account's history as another account.
- A controlled soccer command boundary, runtime tool validation and concrete
  one-use confirmation for consequential model proposals. Soccer history,
  attachments, facts, warnings, titles and results stay out of AI requests.
  Explanations are assembled locally, without a second model call.
- Persistent duplicate-operation receipts and daily AI reservations, bounded
  output/concurrency/timeouts, upstream cancellation and provider price ceilings.
- Bounded exports and table cells, CSV injection protection, rejection of
  formula objects, lazy document libraries, batched streaming rendering and
  shared in-flight game fetches.
- Copies at the roster cache boundary prevent failed writes from appearing
  saved. Forms preserve input on failures and prevent duplicate submissions.
- Account storage is separated from page initialization, and sidebar/settings
  circular imports were removed. Mobile header clipping, drawer focus,
  closed-drawer accessibility, empty-state prompts and rotation labels were fixed.

The scheduling algorithm, fairness priorities, coaching preferences, seeded
variety and position/goalkeeper continuity were not changed.

## Verification

All 202 tests in the full Node regression suite pass, including authentication failures,
password/session invalidation, failed credential/roster writes, export ownership,
Unicode and unknown-name boundaries, outbound-history exclusion, malformed input,
unknown tools, one-use confirmations, duplicate receipts, cancellation,
interrupted streams, and browser-module syntax. Scheduler regression tests pass.

Browser verification used a separate port (3107), temporary fictional private
storage and a mocked provider with a dummy API key. Checks covered login,
General Assistant chat, agent separation, direct roster entry, a simulated
failed save with preserved input, draft creation, confirmation before rating
changes, local privacy clarification, and keyboard drawer open/close/focus.
The interface was inspected at 1280×720 and 390×844. No unexpected console
errors appeared after the final reload. Real-provider availability, model
interpretation quality and live billing were not tested.

The test preload selects temporary private/legacy directories. Tests that call
roster initialization additionally name their isolated legacy directory, so
those tests do not inspect the application's real migration source.

## Dependency review

Express remains on 4.22.2. Compatible security overrides select body-parser
1.20.6 and qs 6.16.0. The final npm audit reports two moderate findings (the
uuid advisory and its dependent ExcelJS), with no high or critical findings.
The affected APIs are uuid v3/v5/v6 buffer-writing paths; the installed ExcelJS
source uses uuid v4. This reduces this application's exposure, but does not
make the dependency audit clean. The suggested ExcelJS 3.4.0 downgrade was
not applied. Revisit the overrides when upstream dependency ranges catch up.

Sources: [uuid advisory](https://github.com/advisories/GHSA-w5hq-g745-h8pq),
[qs advisory](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g),
[body-parser advisory](https://github.com/advisories/GHSA-v422-hmwv-36x6),
[OpenRouter provider price limits](https://openrouter.ai/docs/guides/routing/provider-selection).

## Intentional limits and database follow-up

- Soccer free-form language is narrower: complete supported commands are
  accepted; unresolved prose asks for rephrasing locally. Pseudonyms are not
  anonymity. General Assistant may transmit its own messages/attachments.
- Standing facts require explicit `SEND_STANDING_FACTS=true` and are sent only
  to General Assistant. There is no silent history/context truncation.
- Legacy browser history is retained but cannot be automatically assigned to
  an account safely. Browser localStorage is not encrypted.
- The app remains single-account and single-process. Multi-account enrollment,
  persistent production sessions, cross-process transactions/locking and a
  dollar-accurate usage ledger belong to the database task.
- Confirmations and downloadable exports expire and disappear on restart.
  Durable duplicate receipts reject uncertain retries; users must inspect saved
  results before intentionally starting a new action. Combined actions can
  partially succeed and are not an all-or-nothing database transaction.
- Price ceilings and reservation limits are safeguards, not exact billing.
  Configure a provider API-key spending limit for an account-level currency cap.
- Export generation supports literal text and values, not executable formulas.
  Legacy XLS attachments must be converted to XLSX. Large or malformed inputs
  are rejected; the existing browser document parsers are not a general-purpose
  hostile-document sandbox.

Before normal startup, review `.env.example` for required configuration. The
cleanup did not edit the real `.env` or run migrations against real private data.

## Conversational lineup follow-up

At the owner's request, natural soccer conversation now sends history with
current roster names replaced, plus pseudonymous roster and selected-lineup
context. Unknown or former names and other identifying prose can remain.
This supersedes the command-only/history-exclusion limitations above.
Attachments and standing facts remain excluded. Natural-language tool
proposals require confirmation, including draft creation.
