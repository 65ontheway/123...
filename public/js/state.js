import { apiFetch } from './api.js';
import { readHistory, writeHistory } from './historyStore.js';
// Conversation thread data: localStorage persistence, the active thread,
// and thread lifecycle (create/switch/delete). Owns the one piece of data
// every other module ultimately reads or mutates, so it also orchestrates
// UI events let subscribers update without importing the sidebar.
import { renderHistory } from './messages.js';
const renderThreadList = () => window.dispatchEvent(new Event('thread-list-change'));
const closeSidebarOnMobile = () => window.dispatchEvent(new Event('sidebar-close'));
const handleImageCapabilityChange = () => window.dispatchEvent(new Event('model-capability-change'));

const modelSelect = document.getElementById('model-select');
const input = document.getElementById('input');

// Threads persist in this browser via localStorage (no server-side
// storage). Each thread keeps its own messages and the model last used
// with it.
export const state = { threads: [], activeId: null };
export function loadAccountHistory() { Object.assign(state, readHistory()); }
export function saveState() { writeHistory(state); }

export function getActiveThread() {
  return state.threads.find((t) => t.id === state.activeId) || null;
}

// Passed to messages.js's renderHistory as onLineupUpdate: a lineup card's
// own action (generate another option / finalize / undo) reports its new
// status back here so it survives a reload — mutating the exact message
// object already in the thread's array, same "direct reference" approach
// chat.js uses for a freshly streamed message (see composer submit handler
// below).
function handleLineupUpdate(message, newMeta) {
  message.lineup = newMeta;
  saveState();
}

export function makeThreadTitle(text) {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  // Cap well past anything the sidebar could ever visually fit (even at
  // its max drag width), so the CSS ellipsis on .thread-item-title does
  // the real, width-aware truncation — this cap only exists to avoid
  // storing an entire pasted essay as a "title".
  return trimmed.length > 200 ? trimmed.slice(0, 200) + '…' : trimmed;
}

// After a chat's very first exchange completes, ask the server for a
// short, real title instead of leaving the truncated first message in
// the sidebar forever. Only ever attempted once per chat — the flag
// flips regardless of success so a failure doesn't retry on every message.
export async function maybeGenerateTitle(thread, userText, assistantText, agent) {
  if (!thread || thread.titleGenerated || thread.messages.length !== 2) return;
  thread.titleGenerated = true;
  if (thread.agent === 'soccer-lineup') { thread.title = 'Soccer lineup'; saveState(); renderThreadList(); return; }
  try {
    const res = await apiFetch('/api/generate-title', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // `agent` tells the server whether this thread needs soccer-roster
      // name scrubbing before its title-generation call — omitting it
      // would silently skip that scrubbing (see server.js's
      // /api/generate-title handler).
      body: JSON.stringify({ userMessage: userText.slice(0, 500), assistantMessage: assistantText.slice(0, 500), agent: thread.agent, conversationId: thread.id }),
    });
    const data = await res.json().catch(() => ({}));
    if (data.ok && data.title) {
      thread.title = data.title;
      saveState();
      renderThreadList();
    }
    // On failure, the truncated fallback title set at send time is left as-is.
  } catch {
    // Network error — same fallback-stays-in-place behavior as above.
  }
}

export function touchActiveThread() {
  const thread = getActiveThread();
  if (!thread) return;
  thread.updatedAt = Date.now();
  saveState();
  renderThreadList();
}

function applyThreadModel(thread) {
  const agentSelect = document.getElementById('agent-select');
  agentSelect.value = thread.agent || 'soccer-lineup';
  thread.agent = agentSelect.value;
  agentSelect.dispatchEvent(new Event('change'));
  if (thread.model && [...modelSelect.options].some((o) => o.value === thread.model)) {
    modelSelect.value = thread.model;
  }
  handleImageCapabilityChange();
}

let activeController = null;

// The composer's in-flight fetch AbortController lives here so thread
// switches/creation can cancel a still-streaming reply for the thread being
// left. chat.js reads/sets this via the exported get/set pair below.
export function getActiveController() {
  return activeController;
}

export function setActiveController(controller) {
  activeController = controller;
}

export function switchToThread(id) {
  if (id === state.activeId) return closeSidebarOnMobile();
  if (activeController) activeController.abort();
  const thread = state.threads.find((t) => t.id === id);
  if (!thread) return;
  state.activeId = id;
  renderHistory(thread.messages, { onLineupUpdate: handleLineupUpdate });
  applyThreadModel(thread);
  renderThreadList();
  saveState();
  closeSidebarOnMobile();
}

export function createThread() {
  if (activeController) activeController.abort();
  const thread = {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()),
    title: '',
    model: modelSelect.value || '',
    agent: document.getElementById('agent-select').value || 'default',
    messages: [],
    updatedAt: Date.now(),
    titleGenerated: false, // flips true after the one-shot title generation call, success or fail
  };
  state.threads.push(thread);
  state.activeId = thread.id;
  renderHistory(thread.messages, { onLineupUpdate: handleLineupUpdate });
  renderThreadList();
  saveState();
  closeSidebarOnMobile();
  input.focus();
}

// Wipes every thread — used by the profile screen's "Clear history" button.
// Only mutates data; the profile page navigates back to /chat afterward,
// whose own bootstrap (initActiveThread) already handles an empty thread
// list by creating a fresh one, so this doesn't need to re-render anything
// itself.
export function clearAllHistory() {
  if (activeController) activeController.abort();
  state.threads = [];
  state.activeId = null;
  saveState();
}

export function deleteThread(id) {
  state.threads = state.threads.filter((t) => t.id !== id);
  if (state.activeId !== id) {
    renderThreadList();
    saveState();
    return;
  }
  state.activeId = null;
  const next = [...state.threads].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (next) {
    switchToThread(next.id);
  } else {
    createThread();
  }
}

// One-time bootstrap on page load: pick (or create) the active thread and
// render it. Separate from switchToThread since there's no prior thread to
// abort/compare against and no user-initiated close-the-drawer to do.
export function initActiveThread() {
  if (state.threads.length === 0) {
    createThread();
    return;
  }
  if (!getActiveThread()) {
    state.activeId = [...state.threads].sort((a, b) => b.updatedAt - a.updatedAt)[0].id;
  }
  const thread = getActiveThread();
  renderHistory(thread.messages, { onLineupUpdate: handleLineupUpdate });
  applyThreadModel(thread);
  renderThreadList();
}
