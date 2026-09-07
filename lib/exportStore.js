// Generated export files are held in memory just long enough to be
// downloaded once — a UUID-keyed Map with a 15-minute expiry, not disk,
// since this is a single-process app and the files are small. A periodic
// sweep evicts anything nobody ever fetched, so this never grows unbounded.
const crypto = require('crypto');

const EXPORT_TTL_MS = 15 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

const store = new Map();

function sweepExpired() {
  const now = Date.now();
  for (const [id, entry] of store) {
    if (entry.expiresAt <= now) store.delete(id);
  }
}
setInterval(sweepExpired, SWEEP_INTERVAL_MS).unref();

function storeExport({ buffer, contentType, extension, filename }) {
  const id = crypto.randomUUID();
  const expiresAt = Date.now() + EXPORT_TTL_MS;
  store.set(id, { buffer, contentType, extension, filename, expiresAt });
  return { id, expiresAt };
}

function getExport(id) {
  const entry = store.get(id);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    store.delete(id);
    return null;
  }
  return entry;
}

// A small in-memory sliding-window limiter scoped to export requests. Keyed
// by username the same way roster data is (lib/soccerLineup.js) — there's
// only the one hardcoded account today, but this is already correct once
// real multi-user login lands.
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 10;
const rateLimitLog = new Map();

function checkExportRateLimit(username) {
  const now = Date.now();
  const key = username || 'anonymous';
  const recent = (rateLimitLog.get(key) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX) {
    rateLimitLog.set(key, recent);
    return false;
  }
  recent.push(now);
  rateLimitLog.set(key, recent);
  return true;
}

module.exports = { storeExport, getExport, checkExportRateLimit, EXPORT_TTL_MS };
