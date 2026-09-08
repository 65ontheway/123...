let accountId = null;
export function setAccountId(id) { accountId = id; }
const uncertain = new Map();
export async function apiFetch(url, options = {}) {
  if (accountId) options = { ...options, headers: { ...options.headers, 'X-Account-ID': accountId } };
  const method = options.method || 'GET';
  if (['GET', 'HEAD'].includes(method)) return fetch(url, options);
  const key = JSON.stringify([url, method, options.body]);
  const id = uncertain.get(key) || crypto.randomUUID();
  uncertain.set(key, id);
  const response = await fetch(url, { ...options, headers: { ...options.headers, 'X-Operation-ID': id } });
  if (response.ok || response.status >= 400 && response.status < 500 && response.status !== 409) uncertain.delete(key);
  if (response.ok && url === '/api/logout') {
    try { localStorage.setItem('raygpt.logout', crypto.randomUUID()); } catch {}
  }
  return response;
}
