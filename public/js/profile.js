import { apiFetch } from './api.js';
// The profile page's entry point. Deliberately self-contained rather than
// importing state.js: that module (and the sidebar.js/attachments.js it
// pulls in) wires up event listeners on chat.html-only elements at module
// load time, which would throw on this page. The one piece of state this
// page touches — the thread list — is read/written directly via the same
// localStorage key state.js uses, documented below.

// Must match STORAGE_KEY in state.js.
import { initializeHistoryOwner, clearHistory } from './historyStore.js';
await initializeHistoryOwner();

const usernameEl = document.getElementById('profile-username');
const usagePromptEl = document.getElementById('usage-prompt');
const usageCompletionEl = document.getElementById('usage-completion');
const usageTotalEl = document.getElementById('usage-total');
const clearHistoryBtn = document.getElementById('clear-history-btn');
const clearHistoryStatus = document.getElementById('clear-history-status');
const changePasswordForm = document.getElementById('change-password-form');
const changePasswordStatus = document.getElementById('change-password-status');
const logoutBtn = document.getElementById('logout-btn');

function showStatus(el, message, isError) {
  el.textContent = message;
  el.classList.toggle('profile-status-error', !!isError);
  el.hidden = false;
}

async function loadUsername() {
  try {
    const res = await apiFetch('/api/me');
    if (res.status === 401) {
      window.location.href = '/';
      return;
    }
    const data = await res.json();
    usernameEl.textContent = data.ok ? `Logged in as ${data.username}` : '';
  } catch {
    usernameEl.textContent = '';
  }
}

async function loadUsage() {
  try {
    const res = await apiFetch('/api/session-usage');
    if (res.status === 401) {
      window.location.href = '/';
      return;
    }
    const data = await res.json();
    if (!data.ok) return;
    usagePromptEl.textContent = data.usage.promptTokens.toLocaleString();
    usageCompletionEl.textContent = data.usage.completionTokens.toLocaleString();
    usageTotalEl.textContent = data.usage.totalTokens.toLocaleString();
  } catch {
    // stats just stay at their placeholder dashes
  }
}

clearHistoryBtn.addEventListener('click', () => {
  if (!window.confirm('Delete every chat thread stored in this browser? This can\'t be undone.')) return;
  try {
    clearHistory();
    showStatus(clearHistoryStatus, 'History cleared.', false);
  } catch {
    showStatus(clearHistoryStatus, 'Could not clear history — local storage is unavailable.', true);
  }
});

changePasswordForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const currentPassword = document.getElementById('current-password').value;
  const newPassword = document.getElementById('new-password').value;
  const confirmPassword = document.getElementById('confirm-password').value;

  if (newPassword !== confirmPassword) {
    showStatus(changePasswordStatus, 'New password and confirmation do not match.', true);
    return;
  }

  try {
    const res = await apiFetch('/api/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    const data = await res.json().catch(() => ({}));
    if (data.ok) {
      showStatus(changePasswordStatus, 'Password changed. Please sign in again.', false);
      window.location.replace('/');
      changePasswordForm.reset();
    } else {
      showStatus(changePasswordStatus, data.error || 'Could not change password.', true);
    }
  } catch {
    showStatus(changePasswordStatus, 'Could not reach the server.', true);
  }
});

logoutBtn.addEventListener('click', async () => {
  await apiFetch('/api/logout', { method: 'POST' });
  window.location.href = '/';
});

loadUsername();
loadUsage();
