import { apiFetch, setAccountId } from './api.js';
// Storage has no DOM dependencies. Unattributed legacy history is never imported.
let ownerId = null;
export function historyKey() { return ownerId ? `raygpt.threads.v2.${ownerId}` : null; }
export async function initializeHistoryOwner() {
  const res = await apiFetch('/api/me');
  if (!res.ok) { window.location.replace('/'); throw new Error('Sign-in required'); }
  const account = await res.json();
  ownerId = account.ownerId;
  if (!ownerId) throw new Error('Account identity unavailable');
  setAccountId(ownerId);
  try { localStorage.setItem('raygpt.activeOwner', ownerId); } catch {}
  return account;
}
export function readHistory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(historyKey()) || 'null');
    return Array.isArray(parsed?.threads) ? parsed : { threads: [], activeId: null };
  } catch { return { threads: [], activeId: null }; }
}
export function writeHistory(state) {
  if (!historyKey()) return;
  try { localStorage.setItem(historyKey(), JSON.stringify(state)); }
  catch { window.dispatchEvent(new CustomEvent('history-error')); }
}
export function clearHistory() { if (historyKey()) localStorage.removeItem(historyKey()); }
window.addEventListener('pageshow', event => { if (event.persisted) window.location.reload(); });

window.addEventListener('storage', event => {
  if (event.key === 'raygpt.logout' || event.key === 'raygpt.activeOwner' && event.newValue !== ownerId) window.location.replace('/');
});
