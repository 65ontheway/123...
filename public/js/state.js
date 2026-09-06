// Conversation thread data: localStorage persistence, the active thread,
// and thread lifecycle (create/switch/delete). Owns the one piece of data
// every other module ultimately reads or mutates, so it also orchestrates
// the re-renders a thread change needs — see the note in sidebar.js about
// the mutual import with that module.
import { renderHistory } from './messages.js';
import { renderThreadList, closeSidebarOnMobile } from './sidebar.js';
import { handleImageCapabilityChange } from './attachments.js';

const modelSelect = document.getElementById('model-select');
const input = document.getElementById('input');

// Threads persist in this browser via localStorage (no server-side
// storage). Each thread keeps its own messages and the model last used
// with it.
const STORAGE_KEY = 'raygpt.threads.v1';

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { threads: [], activeId: null };
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.threads) ? parsed : { threads: [], activeId: null };
  } catch {
    return { threads: [], activeId: null };
  }
}

export const state = loadState();

export function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage unavailable (private browsing, quota, etc.) — chat
    // still works this session, it just won't persist across reloads.
  }
}

export function getActiveThread() {
  return state.threads.find((t) => t.id === state.activeId) || null;
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
export async function maybeGenerateTitle(thread, userText, assistantText) {
  if (!thread || thread.titleGenerated || thread.messages.length !== 2) return;
  thread.titleGenerated = true;
  try {
    const res = await fetch('/api/generate-title', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userMessage: userText, assistantMessage: assistantText }),
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
  renderHistory(thread.messages);
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
    messages: [],
    updatedAt: Date.now(),
    titleGenerated: false, // flips true after the one-shot title generation call, success or fail
  };
  state.threads.push(thread);
  state.activeId = thread.id;
  renderHistory(thread.messages);
  renderThreadList();
  saveState();
  closeSidebarOnMobile();
  input.focus();
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
  renderHistory(thread.messages);
  applyThreadModel(thread);
  renderThreadList();
}
