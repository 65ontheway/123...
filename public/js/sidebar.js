// The left sidebar: thread list rendering, inline rename, drag-to-resize,
// and the mobile slide-over drawer (hamburger toggle + backdrop).
//
// Note: this module and state.js import from each other — rendering the
// thread list needs the thread data (state.js), and switching/creating/
// deleting a thread needs to re-render that list (here). That's a genuine
// mutual dependency, not an accident of file layout, and it's safe under ES
// modules because both sides only touch the other's exports inside event
// handlers, never at the top level while the modules are still loading.
import { state, switchToThread, deleteThread, createThread, saveState } from './state.js';

const sidebar = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('sidebar-toggle');
const sidebarResizer = document.getElementById('sidebar-resizer');
const sidebarBackdrop = document.getElementById('sidebar-backdrop');
const newChatBtn = document.getElementById('new-chat-btn');
const threadListEl = document.getElementById('thread-list');

export function closeSidebarOnMobile() {
  sidebar.classList.remove('open');
  sidebarBackdrop.classList.remove('open');
}

export function renderThreadList() {
  threadListEl.innerHTML = '';
  const sorted = [...state.threads].sort((a, b) => b.updatedAt - a.updatedAt);
  for (const t of sorted) {
    const item = document.createElement('div');
    item.className = 'thread-item' + (t.id === state.activeId ? ' active' : '');
    item.tabIndex = 0;
    item.setAttribute('role', 'button');

    const title = document.createElement('span');
    title.className = 'thread-item-title';
    title.textContent = t.title || 'New chat';
    title.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startRenaming(item, title, t);
    });
    item.appendChild(title);

    const rename = document.createElement('button');
    rename.className = 'thread-item-rename';
    rename.textContent = '✎';
    rename.setAttribute('aria-label', 'Rename chat');
    rename.addEventListener('click', (e) => {
      e.stopPropagation();
      startRenaming(item, title, t);
    });
    item.appendChild(rename);

    const del = document.createElement('button');
    del.className = 'thread-item-delete';
    del.textContent = '✕';
    del.setAttribute('aria-label', 'Delete chat');
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteThread(t.id);
    });
    item.appendChild(del);

    item.addEventListener('click', () => switchToThread(t.id));
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        switchToThread(t.id);
      }
    });

    threadListEl.appendChild(item);
  }
}

function startRenaming(item, titleEl, thread) {
  let cancelled = false;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'thread-item-title-input';
  input.value = thread.title || '';
  input.maxLength = 100;

  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelled = true;
      renderThreadList();
    }
  });
  input.addEventListener('blur', () => {
    if (cancelled) return;
    const value = input.value.trim();
    thread.title = value || 'New chat';
    saveState();
    renderThreadList();
  });

  item.replaceChild(input, titleEl);
  input.focus();
  input.select();
}

newChatBtn.addEventListener('click', createThread);
sidebarToggle.addEventListener('click', () => {
  sidebar.classList.toggle('open');
  sidebarBackdrop.classList.toggle('open');
});
sidebarBackdrop.addEventListener('click', closeSidebarOnMobile);

// Drag-to-resize the sidebar. Width is remembered in localStorage so it
// stays put across reloads, same as the thread state.
const SIDEBAR_WIDTH_KEY = 'raygpt.sidebarWidth';
const MIN_SIDEBAR_WIDTH = 160;
const MAX_SIDEBAR_WIDTH = 480;

function applySidebarWidth(px) {
  const clamped = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, px));
  sidebar.style.width = clamped + 'px';
}

try {
  const savedWidth = localStorage.getItem(SIDEBAR_WIDTH_KEY);
  if (savedWidth) applySidebarWidth(parseInt(savedWidth, 10));
} catch {
  // localStorage unavailable — sidebar just uses the default width
}

let resizing = false;

function startResize() {
  resizing = true;
  sidebarResizer.classList.add('dragging');
  document.body.style.userSelect = 'none';
  document.body.style.cursor = 'col-resize';
}

function doResize(clientX) {
  if (!resizing) return;
  const rect = sidebar.getBoundingClientRect();
  applySidebarWidth(clientX - rect.left);
}

function endResize() {
  if (!resizing) return;
  resizing = false;
  sidebarResizer.classList.remove('dragging');
  document.body.style.userSelect = '';
  document.body.style.cursor = '';
  try {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(sidebar.getBoundingClientRect().width)));
  } catch {
    // localStorage unavailable — width just won't persist across reloads
  }
}

sidebarResizer.addEventListener('mousedown', (e) => {
  e.preventDefault();
  startResize();
});
window.addEventListener('mousemove', (e) => doResize(e.clientX));
window.addEventListener('mouseup', endResize);

sidebarResizer.addEventListener('touchstart', startResize, { passive: true });
window.addEventListener('touchmove', (e) => {
  if (!resizing) return;
  doResize(e.touches[0].clientX);
});
window.addEventListener('touchend', endResize);
