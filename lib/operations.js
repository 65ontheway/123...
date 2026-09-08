const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { resolvePrivateDataDir, ensurePrivateDir, atomicWriteFileSync } = require('./privateData');
// Reserve before executing: uncertain/failed writes are never blindly retried.
// Receipts survive restarts. Kept for 24 hours; duplicates return a conflict.
function reserveOperation(ownerId, id, description) {
  if (!/^[a-f0-9-]{36}$/.test(id || '')) return 'invalid';
  const dir = ensurePrivateDir(path.join(resolvePrivateDataDir(), 'operations'));
  const file = path.join(dir, crypto.createHash('sha256').update(ownerId).digest('hex') + '.json');
  let entries;
  try { entries = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { if (err.code !== 'ENOENT') throw err; entries = {}; }
  const now = Date.now();
  for (const [key, entry] of Object.entries(entries)) if (entry.until <= now) delete entries[key];
  if (entries[id]) return 'duplicate';
  if (Object.keys(entries).length >= 1000) return 'limit';
  entries[id] = { until: now + 86400000, fingerprint: crypto.createHash('sha256').update(description).digest('hex') };
  atomicWriteFileSync(file, JSON.stringify(entries));
  return 'reserved';
}
function operations(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  try {
    const result = reserveOperation(req.session.ownerId, req.get('X-Operation-ID') || req.body?.operationId, JSON.stringify([req.method, req.originalUrl, req.body]));
    if (result !== 'reserved') return res.status(result === 'invalid' ? 400 : 409).json({ ok: false, error: result === 'invalid' ? 'A valid operation ID is required.' : 'This action may already have run. Check saved results before starting a new action.' });
    next();
  } catch { res.status(503).json({ ok: false, error: 'Could not reserve this action safely. Nothing was started.' }); }
}
module.exports = { operations, reserveOperation };
