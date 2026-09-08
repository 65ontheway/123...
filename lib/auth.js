const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const privateData = require('./privateData');
const scrypt = promisify(crypto.scrypt);
// scrypt: 32 MiB work factor, r=8, p=1, 64-byte key, random 16-byte salt.
class AuthConfigurationError extends Error {}
const PARAMETERS = Object.freeze({ N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const file = () => path.join(privateData.resolvePrivateDataDir(), 'auth.json');
const legacyFile = () => process.env.RAYGPT_LEGACY_AUTH_FILE || path.join(__dirname, '..', 'data', 'auth.json');
function credentialsMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const digest = x => crypto.createHash('sha256').update(x).digest();
  return crypto.timingSafeEqual(digest(a), digest(b));
}
function validPassword(password) {
  return typeof password === 'string' && password.length >= 12 && Buffer.byteLength(password) <= 1024;
}
function readRecord(location = file()) {
  const record = JSON.parse(fs.readFileSync(location, 'utf8'));
  if (!record || !/^[a-f0-9]{32}$/.test(record.salt) || !/^[a-f0-9]{128}$/.test(record.hash) ||
      (record.N !== undefined && ![16384, 32768].includes(record.N))) throw new Error('Invalid credential record');
  if (location === file() && (typeof record.ownerId !== 'string' || !/^[a-f0-9-]{36}$/.test(record.ownerId) || typeof record.version !== 'string' || !/^[a-f0-9-]{36}$/.test(record.version) || record.username !== process.env.APP_USERNAME)) throw new Error('Invalid credential identity');
  return record;
}
function writeRecord(record) {
  privateData.ensurePrivateDir(path.dirname(file()));
  privateData.atomicWriteFileSync(file(), JSON.stringify(record) + '\n');
}
async function passwordRecord(password, identity) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await scrypt(password, salt, 64, PARAMETERS)).toString('hex');
  return { ...identity, salt, hash, N: PARAMETERS.N, version: crypto.randomUUID() };
}
async function initialize() {
  if (!process.env.APP_USERNAME || !/^[a-zA-Z0-9_-]{1,80}$/.test(process.env.APP_USERNAME)) throw new AuthConfigurationError('APP_USERNAME must contain 1–80 letters, numbers, underscores or hyphens.');
  if (!process.env.SESSION_SECRET || Buffer.byteLength(process.env.SESSION_SECRET) < 32 || process.env.SESSION_SECRET === 'please-change-this-to-a-random-string') throw new AuthConfigurationError('SESSION_SECRET must be a random secret of at least 32 bytes.');
  let record;
  try { record = readRecord(); } catch (err) {
    if (err.code !== 'ENOENT') throw new AuthConfigurationError('Saved credentials cannot be read; authentication is disabled.');
    try { record = readRecord(legacyFile()); } catch (legacyError) {
      if (legacyError.code !== 'ENOENT') throw new AuthConfigurationError('Legacy credentials cannot be read; authentication is disabled.');
      if (!validPassword(process.env.APP_PASSWORD)) throw new AuthConfigurationError('Initial APP_PASSWORD must be 12–1024 bytes (at least 12 characters).');
      record = await passwordRecord(process.env.APP_PASSWORD, {});
    }
    record = { ...record, ownerId: crypto.randomUUID(), username: process.env.APP_USERNAME, version: crypto.randomUUID() };
    writeRecord(record);
  }
  if (!record.ownerId || !record.version || record.username !== process.env.APP_USERNAME) throw new AuthConfigurationError('Credential identity does not match APP_USERNAME; reconcile the account configuration.');
}
async function verifyPassword(password) {
  if (typeof password !== 'string' || Buffer.byteLength(password) > 1024) return false;
  try {
    const record = readRecord();
    const hash = (await scrypt(password, record.salt, 64, { ...PARAMETERS, N: record.N || 16384 })).toString('hex');
    return credentialsMatch(hash, record.hash);
  } catch { return false; }
}
async function setPassword(password) {
  if (!validPassword(password)) throw new Error('Password must contain at least 12 characters and at most 1024 bytes.');
  const current = readRecord();
  const record = await passwordRecord(password, { ownerId: current.ownerId, username: current.username });
  if (identity().version !== current.version) throw new Error('Credentials changed during this request. Sign in again.');
  writeRecord(record);
  return record;
}
function identity() { const { ownerId, username, version } = readRecord(); return { ownerId, username, version }; }
function isAuthenticated(req) {
  try {
    const current = identity();
    if (req.get?.('X-Account-ID') && req.get('X-Account-ID') !== current.ownerId) return false;
    return !!(req.session?.loggedIn && req.session.ownerId === current.ownerId && req.session.authVersion === current.version);
  } catch { return false; }
}
function requireAuth(req, res, next) {
  if (isAuthenticated(req)) return next();
  return res.status(401).json({ ok: false, error: 'Please sign in again.' });
}

module.exports = { AuthConfigurationError, initialize, verifyPassword, setPassword, credentialsMatch, validPassword, identity, requireAuth, isAuthenticated };
