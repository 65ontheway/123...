const crypto = require('node:crypto');
const pending = new Map();
function propose(ownerId, run) {
  const now = Date.now();
  for (const [id, entry] of pending) if (entry.expires <= now) pending.delete(id);
  if (pending.size >= 100) throw new Error('Too many pending actions');
  const id = crypto.randomUUID();
  pending.set(id, { ownerId, run, expires: now + 5 * 60_000 });
  return id;
}
async function confirm(req, res, next) {
  const entry = pending.get(req.params.id);
  if (!entry || entry.ownerId !== req.session.ownerId || entry.expires <= Date.now()) return res.status(409).json({ ok: false, error: 'This confirmation expired or was already used. Request the action again.' });
  pending.delete(req.params.id);
  try { await entry.run(res); } catch (err) { next(err); }
}
module.exports = { propose, confirm };
