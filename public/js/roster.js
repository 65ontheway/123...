import { apiFetch } from './api.js';
// The Soccer Lineup agent's roster panel: shown/hidden based on the
// sidebar's agent picker, and entirely self-contained — it owns its own
// DOM elements and listeners per CLAUDE.md's module-ownership convention,
// so it doesn't need chat.js or settings.js to know it exists. Every
// request here goes straight to /api/soccer/roster*, never through
// /api/chat — adding, editing, or removing a player never calls the model.

const agentSelect = document.getElementById('agent-select');
const panelBtn = document.getElementById('roster-panel-btn');
const panel = document.getElementById('roster-panel');
const backdrop = document.getElementById('roster-panel-backdrop');
const closeBtn = document.getElementById('roster-panel-close');
const storageNoteEl = document.getElementById('roster-storage-note');
const statusEl = document.getElementById('roster-status');
const listEl = document.getElementById('roster-list');
const addForm = document.getElementById('roster-add-form');
const addNameInput = document.getElementById('roster-add-name');
const addOffenseInput = document.getElementById('roster-add-offense');
const addDefenseInput = document.getElementById('roster-add-defense');
const addGoalieInput = document.getElementById('roster-add-goalie');
const prefSelects = {
  defender: document.getElementById('roster-pref-defender'),
  midfielder: document.getElementById('roster-pref-midfielder'),
  forward: document.getElementById('roster-pref-forward'),
};
const formationSelect = document.getElementById('roster-formation');

const SOCCER_AGENT_ID = 'soccer-lineup';
let currentRoster = null;
let editingPlayerId = null;
let adding = false;
statusEl.setAttribute('role', 'status');
statusEl.setAttribute('aria-live', 'polite');

function showStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.classList.toggle('roster-status-error', kind === 'error');
  statusEl.classList.toggle('roster-status-ok', kind === 'ok');
  statusEl.hidden = !text;
}

function updateTriggerVisibility() {
  panelBtn.hidden = agentSelect.value !== SOCCER_AGENT_ID;
  if (panelBtn.hidden && panel.classList.contains('open')) closePanel();
}
agentSelect.addEventListener('change', updateTriggerVisibility);

function openPanel() {
  panel.inert = false;
  panel.classList.add('open');
  backdrop.classList.add('open');
  closeBtn.focus();
  loadRoster();
}
function closePanel() {
  panel.inert = true;
  panel.classList.remove('open');
  panelBtn.focus();
  backdrop.classList.remove('open');
  editingPlayerId = null;
}
panelBtn.addEventListener('click', openPanel);
closeBtn.addEventListener('click', closePanel);
backdrop.addEventListener('click', closePanel);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Tab' && panel.classList.contains('open')) {
    const elements = [...panel.querySelectorAll('button, input, select, [tabindex="0"]')].filter(el => !el.disabled && el.getClientRects().length);
    const first = elements[0], last = elements.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  }
  if (e.key === 'Escape' && panel.classList.contains('open')) closePanel();
});

function ratingsText(skills) {
  const s = skills || {};
  return `Offense ${s.offense ?? '?'} · Defense ${s.defense ?? '?'} · Goalie ${s.goalie ?? '?'}`;
}

function renderPlayerRow(player) {
  const row = document.createElement('div');
  row.className = 'roster-player';

  if (editingPlayerId === player.id) {
    row.appendChild(renderEditForm(player));
    return row;
  }

  const top = document.createElement('div');
  top.className = 'roster-player-row';

  const info = document.createElement('div');
  const nameEl = document.createElement('div');
  nameEl.className = 'roster-player-name';
  nameEl.textContent = player.name;
  const ratingsEl = document.createElement('div');
  ratingsEl.className = 'roster-player-ratings';
  ratingsEl.textContent = ratingsText(player.skills);
  info.append(nameEl, ratingsEl);

  const actions = document.createElement('div');
  actions.className = 'roster-player-actions';
  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.textContent = '✏️';
  editBtn.setAttribute('aria-label', `Edit ${player.name}`);
  editBtn.addEventListener('click', () => {
    editingPlayerId = player.id;
    renderList();
  });
  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'roster-delete-btn';
  deleteBtn.textContent = '🗑️';
  deleteBtn.setAttribute('aria-label', `Remove ${player.name}`);
  deleteBtn.addEventListener('click', () => deletePlayer(player));
  actions.append(editBtn, deleteBtn);

  top.append(info, actions);
  row.appendChild(top);
  return row;
}

function renderEditForm(player) {
  const form = document.createElement('form');
  form.className = 'roster-edit-form';

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.value = player.name;
  nameInput.maxLength = 100;
  nameInput.required = true;
  nameInput.setAttribute('aria-label', 'Player name');

  const ratingRow = document.createElement('div');
  ratingRow.className = 'roster-rating-row';
  const makeRatingField = (label, value) => {
    const wrap = document.createElement('label');
    wrap.textContent = label;
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '1';
    input.max = '5';
    input.value = value ?? 3;
    wrap.appendChild(input);
    return { wrap, input };
  };
  const offenseField = makeRatingField('Offense', player.skills?.offense);
  const defenseField = makeRatingField('Defense', player.skills?.defense);
  const goalieField = makeRatingField('Goalie', player.skills?.goalie);
  ratingRow.append(offenseField.wrap, defenseField.wrap, goalieField.wrap);

  const actions = document.createElement('div');
  actions.className = 'roster-edit-actions';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.className = 'roster-save-btn';
  saveBtn.textContent = 'Save';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'roster-cancel-btn';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => {
    editingPlayerId = null;
    renderList();
  });
  actions.append(saveBtn, cancelBtn);

  form.append(nameInput, ratingRow, actions);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    savePlayerEdit(player, {
      name: nameInput.value,
      offense: Number(offenseField.input.value),
      defense: Number(defenseField.input.value),
      goalie: Number(goalieField.input.value),
    });
  });
  return form;
}

function renderList() {
  listEl.innerHTML = '';
  if (!currentRoster || currentRoster.players.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'roster-empty';
    empty.textContent = 'No players yet — add your first one below.';
    listEl.appendChild(empty);
    return;
  }
  for (const player of currentRoster.players) {
    listEl.appendChild(renderPlayerRow(player));
  }
}

async function loadRoster() {
  showStatus('Loading roster…', null);
  listEl.innerHTML = '';
  try {
    const res = await apiFetch('/api/soccer/roster');
    if (res.status === 401) {
      window.location.href = '/';
      return;
    }
    const data = await res.json();
    if (!data.ok) {
      showStatus(data.error || 'Could not load the roster.', 'error');
      return;
    }
    currentRoster = data.roster;
    storageNoteEl.textContent = data.storageNote || '';
    showStatus('', null);
    renderList();
    renderSidePreferences();
    renderFormation();
  } catch {
    showStatus('Could not reach the server.', 'error');
  }
}

function renderSidePreferences() {
  const prefs = currentRoster?.sidePreferences || {};
  for (const role of Object.keys(prefSelects)) {
    prefSelects[role].value = prefs[role] || 'none';
  }
}

function renderFormation() {
  formationSelect.value = currentRoster?.formation || '2-3-1';
}

// Auto-saves the moment the formation changes — same immediate-feedback
// pattern as saveSidePreference below, through the same settings endpoint.
async function saveFormation(formation) {
  showStatus('Saving…', null);
  try {
    const res = await apiFetch('/api/soccer/roster/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ formation }),
    });
    if (res.status === 401) {
      window.location.href = '/';
      return;
    }
    const data = await res.json();
    if (!data.ok) {
      showStatus(data.error || 'Could not save the formation.', 'error');
      return;
    }
    if (currentRoster) currentRoster.formation = data.formation;
    showStatus('Saved.', 'ok');
  } catch {
    showStatus('Could not reach the server.', 'error');
  }
}
formationSelect.addEventListener('change', () => saveFormation(formationSelect.value));

// Auto-saves the moment a select changes — no separate save button, same
// as every other action in this panel giving immediate feedback. Only the
// one role that changed is sent, so the other two are never touched,
// matching applyLineupSettings' partial-update contract on the server.
async function saveSidePreference(role, value) {
  showStatus('Saving…', null);
  try {
    const res = await apiFetch('/api/soccer/roster/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [role]: value }),
    });
    if (res.status === 401) {
      window.location.href = '/';
      return;
    }
    const data = await res.json();
    if (!data.ok) {
      showStatus(data.error || 'Could not save that preference.', 'error');
      return;
    }
    if (currentRoster) currentRoster.sidePreferences = data.sidePreferences;
    showStatus('Saved.', 'ok');
  } catch {
    showStatus('Could not reach the server.', 'error');
  }
}

for (const [role, select] of Object.entries(prefSelects)) {
  select.addEventListener('change', () => saveSidePreference(role, select.value));
}

async function deletePlayer(player) {
  if (!window.confirm(`Remove ${player.name} from the roster? This can't be undone.`)) return;
  showStatus('Removing…', null);
  try {
    const res = await apiFetch(`/api/soccer/roster/players/${encodeURIComponent(player.id)}`, { method: 'DELETE' });
    if (res.status === 401) {
      window.location.href = '/';
      return;
    }
    const data = await res.json();
    if (!data.ok) {
      showStatus(data.error || 'Could not remove the player.', 'error');
      return;
    }
    currentRoster.players = currentRoster.players.filter((p) => p.id !== player.id);
    showStatus('Removed.', 'ok');
    renderList();
  } catch {
    showStatus('Could not reach the server.', 'error');
  }
}

async function savePlayerEdit(player, fields) {
  showStatus('Saving…', null);
  try {
    const res = await apiFetch(`/api/soccer/roster/players/${encodeURIComponent(player.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    });
    if (res.status === 401) {
      window.location.href = '/';
      return;
    }
    const data = await res.json();
    if (!data.ok) {
      showStatus(data.error || 'Could not save the change.', 'error');
      return;
    }
    const idx = currentRoster.players.findIndex((p) => p.id === player.id);
    if (idx !== -1) currentRoster.players[idx] = data.player;
    editingPlayerId = null;
    showStatus('Saved.', 'ok');
    renderList();
  } catch {
    showStatus('Could not reach the server.', 'error');
  }
}

addForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (adding) return;
  const name = addNameInput.value.trim();
  if (!name) return;
  adding = true;
  const submit = addForm.querySelector('[type=submit]');
  submit.disabled = true;
  showStatus('Saving…', null);
  try {
    const res = await apiFetch('/api/soccer/roster/players', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        offense: Number(addOffenseInput.value),
        defense: Number(addDefenseInput.value),
        goalie: Number(addGoalieInput.value),
      }),
    });
    if (res.status === 401) {
      window.location.href = '/';
      return;
    }
    const data = await res.json();
    if (!data.ok) {
      showStatus(data.error || 'Could not add the player.', 'error');
      return;
    }
    if (!currentRoster) currentRoster = { formation: '2-3-1', players: [] };
    currentRoster.players.push(data.player);
    addForm.reset();
    addOffenseInput.value = 3;
    addDefenseInput.value = 3;
    addGoalieInput.value = 3;
    showStatus('Added.', 'ok');
    renderList();
  } catch {
    showStatus('Could not reach the server.', 'error');
  } finally { adding = false; submit.disabled = false; }
});

updateTriggerVisibility();
