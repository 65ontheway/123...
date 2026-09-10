import { apiFetch } from './api.js';
// Draft/finalized lineup cards: a compact quarters/bench view plus
// "Generate another option" / "Mark used" / "Undo" controls for one saved
// game. Appended below the assistant bubble that mentions it (same slot
// renderExportChip uses in messages.js), for both a freshly streamed reply
// (chat.js) and a reopened thread (messages.js's renderHistory).
//
// Self-contained like messages.js: takes the lineup reference (`meta`,
// `{gameId, date, status, draftId, rotationInfluenced}`) as an argument and
// reports changes back via an `onUpdate` callback instead of importing
// state.js — the caller decides how (or whether) to persist them.
//
// Button clicks never call the LLM: they hit the plain REST routes under
// /api/soccer/games/... (soccerLineupRoutes.js) and render the computed
// result directly, per CLAUDE.md's chat-feature conventions (loading/error
// states, duplicate-submit protection) and the app's existing module-
// ownership convention (this file owns its own DOM/listeners).

function formatPositionLabel(positionId) {
  return String(positionId || '')
    .split('_')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

// Where each exact position sits on the pitch, as a percentage of the
// field's width/height (0,0 top-left; attacking end at the top, goalkeeper
// at the bottom). One shared table works for every formation the app
// supports — a given position id (e.g. "left_back") always means the same
// role/side no matter which formation it belongs to, so this never needs
// to branch on formation name.
const POSITION_COORDS = {
  goalkeeper: { x: 50, y: 90 },
  left_back: { x: 18, y: 70 },
  center_back: { x: 50, y: 73 },
  right_back: { x: 82, y: 70 },
  left_wing: { x: 14, y: 38 },
  center_mid: { x: 50, y: 42 },
  right_wing: { x: 86, y: 38 },
  left_midfield: { x: 26, y: 40 },
  right_midfield: { x: 74, y: 40 },
  striker: { x: 50, y: 12 },
  left_forward: { x: 30, y: 12 },
  right_forward: { x: 70, y: 12 },
};

const POSITION_ABBREV = {
  goalkeeper: 'GK',
  left_back: 'LB',
  center_back: 'CB',
  right_back: 'RB',
  left_wing: 'LW',
  center_mid: 'CM',
  right_wing: 'RW',
  left_midfield: 'LM',
  right_midfield: 'RM',
  striker: 'ST',
  left_forward: 'LF',
  right_forward: 'RF',
};

// A jersey-style chip has little room for a full name — first name only
// (how a coach naturally refers to their own players) keeps it readable.
function shortDisplayName(name) {
  if (!name) return '';
  const first = name.trim().split(/\s+/)[0];
  return first.length > 12 ? `${first.slice(0, 11)}…` : first;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

// One quarter's lineup, drawn as a small pitch diagram — a coach reads a
// shape on a field far faster than a list of position names. The SVG
// itself is decorative (aria-hidden); a plain-text equivalent right below
// it (visually hidden, not display:none, so it stays in the accessibility
// tree) keeps this exactly as usable for a screen reader as the original
// text list was.
//
// Every visual attribute here (fill, stroke, font-size) is set directly on
// the SVG elements rather than left to the external stylesheet, and the
// SVG itself carries explicit width/height="100%" rather than relying on
// CSS aspect-ratio applied to the <svg> replaced element directly (a
// wrapping div carries the aspect-ratio instead) — both are deliberate,
// since a dynamically created SVG subtree sizing or coloring itself off an
// external stylesheet has turned out to be unreliable in at least one real
// browser, and an unstyled SVG shape defaults to a solid black fill, which
// reads as a broken render rather than a merely unstyled one.
const FIELD_GREEN = '#2e8b4e';
const FIELD_LINE = 'rgba(255,255,255,0.55)';
const FIELD_BOUNDARY = 'rgba(255,255,255,0.85)';
const CHIP_FILL = '#2f6fed';
const CHIP_EMPTY_FILL = 'rgba(255,255,255,0.3)';

function renderField(lineup) {
  const wrap = document.createElement('div');
  wrap.className = 'lineup-field-wrap';

  const frame = document.createElement('div');
  frame.className = 'lineup-field-frame';
  wrap.appendChild(frame);

  // The viewBox is taller than the pitch itself (108 vs. the pitch's own
  // 96-tall 2..98 span) so the goalkeeper's name label — anchored below a
  // chip sitting right at the bottom edge of the pitch — has room to
  // render without being clipped by the SVG's own boundary.
  const svg = svgEl('svg', {
    viewBox: '0 0 100 108',
    width: '100%',
    height: '100%',
    preserveAspectRatio: 'xMidYMid meet',
    'aria-hidden': 'true',
    focusable: 'false',
  });
  svg.style.display = 'block';
  frame.appendChild(svg);

  const turf = svgEl('rect', { x: 2, y: 2, width: 96, height: 96, rx: 4, fill: FIELD_GREEN });
  svg.appendChild(turf);
  for (const attrs of [
    { x: 25, y: 2, width: 50, height: 12 },
    { x: 25, y: 86, width: 50, height: 12 },
  ]) {
    svg.appendChild(svgEl('rect', { ...attrs, fill: 'none', stroke: FIELD_LINE, 'stroke-width': 0.5 }));
  }
  svg.appendChild(svgEl('line', { x1: 2, y1: 50, x2: 98, y2: 50, stroke: FIELD_LINE, 'stroke-width': 0.5 }));
  svg.appendChild(svgEl('circle', { cx: 50, cy: 50, r: 9, fill: 'none', stroke: FIELD_LINE, 'stroke-width': 0.5 }));
  svg.appendChild(svgEl('rect', { x: 2, y: 2, width: 96, height: 96, rx: 4, fill: 'none', stroke: FIELD_BOUNDARY, 'stroke-width': 0.6 }));

  for (const slot of lineup) {
    const coords = POSITION_COORDS[slot.position] || { x: 50, y: 50 };
    const filled = !!slot.player;
    const g = svgEl('g', {});

    const chip = svgEl('circle', {
      cx: coords.x,
      cy: coords.y,
      r: 6.5,
      fill: filled ? CHIP_FILL : CHIP_EMPTY_FILL,
      stroke: '#fff',
      'stroke-width': filled ? 0.8 : 0.6,
    });
    if (!filled) chip.setAttribute('stroke-dasharray', '1.2');
    g.appendChild(chip);

    const abbrev = svgEl('text', { x: coords.x, y: coords.y + 1.6, 'text-anchor': 'middle', fill: '#fff' });
    abbrev.style.fontSize = '4.2px';
    abbrev.style.fontWeight = '700';
    abbrev.textContent = POSITION_ABBREV[slot.position] || '';
    g.appendChild(abbrev);

    const label = svgEl('text', {
      x: coords.x,
      y: coords.y + 11.5,
      'text-anchor': 'middle',
      fill: '#fff',
      stroke: 'rgba(0,0,0,0.55)',
      'stroke-width': 1.4,
    });
    label.style.fontSize = '4.6px';
    label.style.fontWeight = '600';
    label.style.paintOrder = 'stroke';
    label.textContent = filled ? shortDisplayName(slot.player.name) : '(unfilled)';
    g.appendChild(label);

    svg.appendChild(g);
  }

  const srSummary = document.createElement('p');
  srSummary.className = 'sr-only';
  srSummary.textContent = lineup
    .map((slot) => `${formatPositionLabel(slot.position)}: ${slot.player ? slot.player.name : 'unfilled'}`)
    .join('. ');
  wrap.appendChild(srSummary);

  return wrap;
}

function statusLabel(status) {
  return status === 'finalized' ? 'Finalized' : 'Draft';
}

// A single sheet shared by every lineup card on the page, rather than one
// per card — printing is a page-wide operation (the browser prints
// whatever's visible), so there only ever needs to be one, populated fresh
// right before window.print() is called. Lives outside any card, appended
// straight to <body>; CSS hides it (and everything else) except during an
// actual print, per the print rules in lineup.css.
let printSheet = null;
function getPrintSheet() {
  if (!printSheet) {
    printSheet = document.createElement('div');
    printSheet.id = 'lineup-print-sheet';
    document.body.appendChild(printSheet);
  }
  return printSheet;
}

// One quarter's printable cell: same pitch diagram as the on-screen card
// (renderField), plus bench/resting — everything a coach needs sideline,
// nothing else. Quarter number is the only thing sized up here; the field
// diagram and text stay exactly as compact as the on-screen version so all
// four fit one landscape page together.
function buildPrintQuarter(q) {
  const cell = document.createElement('div');
  cell.className = 'lineup-print-quarter';

  const h = document.createElement('div');
  h.className = 'lineup-print-quarter-title';
  h.textContent = `Quarter ${q.quarter}`;
  cell.appendChild(h);

  cell.appendChild(renderField(q.lineup));

  if (q.bench.length > 0) {
    const bench = document.createElement('div');
    bench.className = 'lineup-print-note';
    bench.textContent = `Bench: ${q.bench.map((p) => p.name).join(', ')}`;
    cell.appendChild(bench);
  }
  if (q.resting && q.resting.length > 0) {
    const resting = document.createElement('div');
    resting.className = 'lineup-print-note';
    resting.textContent = `Resting: ${q.resting.map((p) => p.name).join(', ')}`;
    cell.appendChild(resting);
  }
  return cell;
}

// Quarters 1-4 always print in that fixed reading order — top-left,
// top-right, bottom-left, bottom-right — matching AYSO's own halves (Q1+Q2
// is the first half, Q3+Q4 the second), regardless of the CSS grid's own
// column/row mechanics, so a coach reading the printed page left-to-right,
// top-to-bottom always reads the game in the order it's actually played.
function printLineup(game) {
  const draft = game.drafts[game.selectedDraftId];
  if (!draft) return;
  const sheet = getPrintSheet();
  sheet.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'lineup-print-header';
  header.textContent = `${game.date || ''} — ${statusLabel(game.status)}`;
  sheet.appendChild(header);

  const grid = document.createElement('div');
  grid.className = 'lineup-print-grid';
  for (const q of draft.result.quarters) grid.appendChild(buildPrintQuarter(q));
  sheet.appendChild(grid);

  window.print();
}

const gameRequests = new Map();
function fetchGame(gameId) {
  if (gameRequests.has(gameId)) return gameRequests.get(gameId);
  const promise = loadGame(gameId).finally(() => gameRequests.delete(gameId));
  gameRequests.set(gameId, promise);
  return promise;
}
async function loadGame(gameId) {
  const res = await apiFetch(`/api/soccer/games/${encodeURIComponent(gameId)}`);
  if (res.status === 401) {
    window.location.href = '/';
    return null;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || 'Could not load that saved lineup.');
  return data.game;
}

async function postAction(gameId, action) {
  const res = await apiFetch(`/api/soccer/games/${encodeURIComponent(gameId)}/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (res.status === 401) {
    window.location.href = '/';
    return null;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || 'That action failed — please try again.');
  return data;
}

function metaFromGame(game) {
  const draft = game.drafts[game.selectedDraftId];
  return {
    gameId: game.gameId,
    date: game.date,
    status: game.status,
    draftId: game.selectedDraftId,
    rotationInfluenced: !!(draft && draft.result && draft.result.rotationInfluenced),
    historyConsidered: (game.frozenInputs.rotationStatsSnapshot?.gamesConsidered || 0) > 0,
  };
}

function renderQuarters(el, game) {
  el.innerHTML = '';
  const draft = game.drafts[game.selectedDraftId];
  if (!draft) return;
  for (const q of draft.result.quarters) {
    const qDiv = document.createElement('div');
    qDiv.className = 'lineup-quarter';

    const h = document.createElement('div');
    h.className = 'lineup-quarter-title';
    h.textContent = `Quarter ${q.quarter}`;
    qDiv.appendChild(h);

    qDiv.appendChild(renderField(q.lineup));

    if (q.bench.length > 0) {
      const bench = document.createElement('div');
      bench.className = 'lineup-bench';
      bench.textContent = `Bench: ${q.bench.map((p) => p.name).join(', ')}`;
      qDiv.appendChild(bench);
    }
    if (q.resting && q.resting.length > 0) {
      const resting = document.createElement('div');
      resting.className = 'lineup-bench lineup-resting';
      resting.textContent = `Resting: ${q.resting.map((p) => p.name).join(', ')}`;
      qDiv.appendChild(resting);
    }
    el.appendChild(qDiv);
  }

  if (draft.distinctFromPrevious === false) {
    const note = document.createElement('p');
    note.className = 'lineup-limited-note';
    note.textContent = 'No meaningfully different alternative was found within current constraints — this is the closest option.';
    el.appendChild(note);
  }
}

// `container` is the bubble to append into; `meta` is the lightweight
// {gameId, date, status, draftId, rotationInfluenced} reference the app
// already has (from chat's delta.lineup or a saved message). The full
// lineup is always re-fetched fresh from the server on render — this is a
// read, never a recompute, so reopening a saved game is side-effect free.
export function renderLineupCard(container, meta, { onUpdate } = {}) {
  if (!meta || !meta.gameId) return;

  const card = document.createElement('div');
  card.className = 'lineup-card';

  const header = document.createElement('div');
  header.className = 'lineup-card-header';
  const badge = document.createElement('span');
  badge.className = 'lineup-status-badge';
  const dateEl = document.createElement('span');
  dateEl.className = 'lineup-date';
  header.append(badge, dateEl);
  card.appendChild(header);

  const note = document.createElement('p');
  note.className = 'lineup-rotation-note';
  note.hidden = true;
  note.textContent = 'Finalized planned assignments were considered alongside lineup variety.';
  card.appendChild(note);

  const rosterChangedNote = document.createElement('p');
  rosterChangedNote.className = 'lineup-roster-changed';
  rosterChangedNote.hidden = true;
  rosterChangedNote.textContent = 'Your roster has changed since this lineup was generated.';
  card.appendChild(rosterChangedNote);

  const body = document.createElement('div');
  body.className = 'lineup-card-body';
  body.textContent = 'Loading…';
  card.appendChild(body);

  const statusMsg = document.createElement('p');
  statusMsg.className = 'lineup-action-status';
  statusMsg.hidden = true;
  statusMsg.setAttribute('role', 'status');
  card.appendChild(statusMsg);

  const actions = document.createElement('div');
  actions.className = 'lineup-actions';
  card.appendChild(actions);

  container.appendChild(card);

  let currentMeta = { ...meta };
  let currentGame = null;

  function setActionsDisabled(disabled) {
    for (const btn of actions.querySelectorAll('button')) btn.disabled = disabled;
  }

  function showStatus(text, isError) {
    statusMsg.hidden = !text;
    statusMsg.textContent = text || '';
    statusMsg.classList.toggle('lineup-action-error', !!isError);
  }

  function renderActions() {
    actions.innerHTML = '';

    const altBtn = document.createElement('button');
    altBtn.type = 'button';
    altBtn.className = 'lineup-btn';
    altBtn.textContent = '🔀 Generate another option';
    altBtn.addEventListener('click', () => {
      if (currentMeta.status === 'finalized' && !window.confirm('Generate another option and return this game to draft status?')) return;
      runAction('alternative');
    });
    actions.appendChild(altBtn);

    const printBtn = document.createElement('button');
    printBtn.type = 'button';
    printBtn.className = 'lineup-btn';
    printBtn.textContent = '🖨️ Print';
    printBtn.addEventListener('click', () => currentGame && printLineup(currentGame));
    actions.appendChild(printBtn);

    if (currentMeta.status === 'finalized') {
      const undoBtn = document.createElement('button');
      undoBtn.type = 'button';
      undoBtn.className = 'lineup-btn lineup-btn-secondary';
      undoBtn.textContent = '↩️ Undo (unmark as used)';
      undoBtn.addEventListener('click', () => {
        if (!window.confirm('Unmark this lineup as used? It will stop counting toward future rotation history.')) return;
        runAction('unfinalize');
      });
      actions.appendChild(undoBtn);
    } else {
      const finalizeBtn = document.createElement('button');
      finalizeBtn.type = 'button';
      finalizeBtn.className = 'lineup-btn lineup-btn-primary';
      finalizeBtn.textContent = '✅ Mark used';
      finalizeBtn.addEventListener('click', () => runAction('finalize'));
      actions.appendChild(finalizeBtn);
    }
  }

  function renderCard() {
    badge.className = `lineup-status-badge ${currentMeta.status === 'finalized' ? 'finalized' : 'draft'}`;
    badge.textContent = statusLabel(currentMeta.status);
    dateEl.textContent = currentMeta.date || '';
    note.hidden = !currentMeta.historyConsidered;
    rosterChangedNote.hidden = !(currentGame && currentGame.rosterChanged);
    if (currentGame) renderQuarters(body, currentGame);
    renderActions();
  }

  async function runAction(action) {
    setActionsDisabled(true);
    showStatus(
      action === 'alternative' ? 'Generating another option…' : action === 'finalize' ? 'Marking used…' : 'Undoing…',
      false
    );
    try {
      const data = await postAction(currentMeta.gameId, action);
      if (!data) return; // 401 — redirect already under way
      currentGame = data.game;
      currentMeta = metaFromGame(currentGame);
      renderCard();
      if (action === 'finalize' && data.alreadyFinalized) {
        showStatus('Already marked used.', false);
      } else {
        showStatus('', false);
      }
      if (onUpdate) onUpdate(currentMeta);
    } catch (err) {
      showStatus(err.message || 'That action failed — please try again.', true);
    } finally {
      setActionsDisabled(false);
    }
  }

  badge.textContent = statusLabel(meta.status);
  badge.className = `lineup-status-badge ${meta.status === 'finalized' ? 'finalized' : 'draft'}`;
  dateEl.textContent = meta.date || '';
  note.hidden = !meta.historyConsidered;

  fetchGame(meta.gameId)
    .then((game) => {
      if (!game) return;
      currentGame = game;
      currentMeta = metaFromGame(game);
      renderCard();
      if (onUpdate) onUpdate(currentMeta);
    })
    .catch((err) => {
      body.textContent = err.message || 'Could not load that saved lineup.';
      renderActions();
    });
}
