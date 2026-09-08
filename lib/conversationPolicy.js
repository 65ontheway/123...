const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { resolvePrivateDataDir, ensurePrivateDir, atomicWriteFileSync } = require('./privateData');
function bindConversation(req, res, next) {
  const { conversationId, agent = 'default' } = req.body || {};
  if (!/^[a-f0-9-]{36}$/.test(conversationId || '') || !['default', 'soccer-lineup'].includes(agent)) return res.status(400).json({ ok: false, error: 'A valid conversation and agent are required.' });
  try {
    const dir = ensurePrivateDir(path.join(resolvePrivateDataDir(), 'conversation-policies'));
    const file = path.join(dir, crypto.createHash('sha256').update(req.session.ownerId + ':' + conversationId).digest('hex') + '.json');
    let policy;
    try { policy = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      policy = { agent };
      atomicWriteFileSync(file, JSON.stringify(policy));
    }
    if (policy.agent !== agent) return res.status(409).json({ ok: false, error: 'Start a new conversation to change agents. This protects private soccer history.' });
    next();
  } catch { res.status(503).json({ ok: false, error: 'Conversation privacy policy could not be verified.' }); }
}
module.exports = { bindConversation };
