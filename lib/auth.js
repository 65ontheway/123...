// Password storage for the single hardcoded account. Login always checks
// the username against APP_USERNAME (no username changes supported), but
// the password can now be changed from the app instead of hand-editing
// .env: once changed, it's hashed and stored in data/auth.json (git-ignored,
// same pattern as roster.json/facts.md) and checked from there instead.
// Until the first change, there's no file yet, so login falls back to
// comparing against APP_PASSWORD directly — existing setups keep working
// with zero migration step.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const AUTH_FILE = path.join(__dirname, '..', 'data', 'auth.json');
const SCRYPT_KEYLEN = 64;

let authCache = { record: null, mtimeMs: 0 };

function loadAuthRecord() {
  try {
    const mtimeMs = fs.statSync(AUTH_FILE).mtimeMs;
    if (mtimeMs !== authCache.mtimeMs) {
      const parsed = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
      if (typeof parsed.salt === 'string' && typeof parsed.hash === 'string') {
        authCache = { record: parsed, mtimeMs };
      } else {
        authCache = { record: null, mtimeMs };
      }
    }
  } catch {
    authCache = { record: null, mtimeMs: 0 };
  }
  return authCache.record;
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
}

function credentialsMatch(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA); // keep timing roughly constant
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function verifyPassword(password) {
  if (typeof password !== 'string') return false;
  const record = loadAuthRecord();
  if (record) {
    const candidateHash = hashPassword(password, record.salt);
    return credentialsMatch(candidateHash, record.hash);
  }
  return credentialsMatch(password, process.env.APP_PASSWORD || 'changeme');
}

function setPassword(newPassword) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(newPassword, salt);
  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
  fs.writeFileSync(AUTH_FILE, JSON.stringify({ salt, hash }, null, 2) + '\n', 'utf8');
  authCache = { record: { salt, hash }, mtimeMs: fs.statSync(AUTH_FILE).mtimeMs };
}

module.exports = { verifyPassword, setPassword, credentialsMatch };
