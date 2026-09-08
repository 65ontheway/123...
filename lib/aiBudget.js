const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ensurePrivateDir, resolvePrivateDataDir, atomicWriteFileSync } = require('./privateData');
function reserveBudget(ownerId, output, inputBytes) {
  const dir = ensurePrivateDir(path.join(resolvePrivateDataDir(), 'ai-budgets'));
  const file = path.join(dir, crypto.createHash('sha256').update(ownerId).digest('hex') + '.json');
  let budget;
  try { budget = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  const now = Date.now();
  if (!budget || budget.until <= now) budget = { count: 0, output: 0, inputBytes: 0, until: now + 86400000 };
  if (!Number.isFinite(budget.count) || !Number.isFinite(budget.output) || !Number.isFinite(budget.inputBytes)) throw new Error('Invalid budget record');
  if (budget.count >= 100 || budget.output + output > 300000 || budget.inputBytes + inputBytes > 16 * 1024 * 1024) return false;
  budget.count++; budget.output += output; budget.inputBytes += inputBytes;
  atomicWriteFileSync(file, JSON.stringify(budget));
  return true;
}
module.exports = { reserveBudget };
