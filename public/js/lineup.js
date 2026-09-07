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

function statusLabel(status) {
  return status === 'finalized' ? 'Finalized' : 'Draft';
}

async function fetchGame(gameId) {
  const res = await fetch(`/api/soccer/games/${encodeURIComponent(gameId)}`);
  if (res.status === 401) {
    window.location.href = '/';
    return null;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || 'Could not load that saved lineup.');
  return data.game;
}

async function postAction(gameId, action) {
  const res = await fetch(`/api/soccer/games/${encodeURIComponent(gameId)}/${action}`, {
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

    const list = document.createElement('div');
    list.className = 'lineup-slots';
    for (const slot of q.lineup) {
      const row = document.createElement('div');
      row.className = 'lineup-slot';
      const pos = document.createElement('span');
      pos.className = 'lineup-slot-pos';
      pos.textContent = formatPositionLabel(slot.position);
      const name = document.createElement('span');
      name.className = 'lineup-slot-name';
      name.textContent = slot.player ? slot.player.name : '(unfilled)';
      row.append(pos, name);
      list.appendChild(row);
    }
    qDiv.appendChild(list);

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
  note.textContent = 'Recent finalized-game history influenced this lineup.';
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
    altBtn.addEventListener('click', () => runAction('alternative'));
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
    note.hidden = !currentMeta.rotationInfluenced;
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
  note.hidden = !meta.rotationInfluenced;

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
