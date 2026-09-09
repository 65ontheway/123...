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
function renderField(lineup) {
  const wrap = document.createElement('div');
  wrap.className = 'lineup-field-wrap';

  // The viewBox is taller than the pitch itself (108 vs. the pitch's own
  // 96-tall 2..98 span) so the goalkeeper's name label — anchored below a
  // chip sitting right at the bottom edge of the pitch — has room to
  // render without being clipped by the SVG's own boundary.
  const svg = svgEl('svg', { viewBox: '0 0 100 108', class: 'lineup-field', 'aria-hidden': 'true', focusable: 'false' });
  svg.appendChild(svgEl('rect', { x: 2, y: 2, width: 96, height: 96, rx: 4, class: 'field-turf' }));
  svg.appendChild(svgEl('rect', { x: 25, y: 2, width: 50, height: 12, class: 'field-marking' }));
  svg.appendChild(svgEl('rect', { x: 25, y: 86, width: 50, height: 12, class: 'field-marking' }));
  svg.appendChild(svgEl('line', { x1: 2, y1: 50, x2: 98, y2: 50, class: 'field-marking-line' }));
  svg.appendChild(svgEl('circle', { cx: 50, cy: 50, r: 9, class: 'field-marking' }));
  svg.appendChild(svgEl('rect', { x: 2, y: 2, width: 96, height: 96, rx: 4, class: 'field-boundary' }));

  for (const slot of lineup) {
    const coords = POSITION_COORDS[slot.position] || { x: 50, y: 50 };
    const filled = !!slot.player;
    const g = svgEl('g', { class: filled ? 'field-slot' : 'field-slot field-slot-empty' });
    g.appendChild(svgEl('circle', { cx: coords.x, cy: coords.y, r: 6.5, class: 'field-chip' }));
    const abbrev = svgEl('text', { x: coords.x, y: coords.y + 1.6, class: 'field-chip-pos', 'text-anchor': 'middle' });
    abbrev.textContent = POSITION_ABBREV[slot.position] || '';
    g.appendChild(abbrev);
    const label = svgEl('text', { x: coords.x, y: coords.y + 11.5, class: 'field-chip-label', 'text-anchor': 'middle' });
    label.textContent = filled ? shortDisplayName(slot.player.name) : '(unfilled)';
    g.appendChild(label);
    svg.appendChild(g);
  }
  wrap.appendChild(svg);

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
