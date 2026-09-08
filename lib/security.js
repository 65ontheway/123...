const attempts = new Map();
let activeLogins = 0;
function loginLimit(req, res, next) {
  const now = Date.now();
  for (const [key, entry] of attempts) if (entry.until <= now) attempts.delete(key);
  const key = req.ip;
  const entry = attempts.get(key) || { count: 0, until: now + 15 * 60_000 };
  if (entry.count >= 10 || attempts.size >= 10000 || activeLogins >= 4) return res.status(429).json({ ok: false, error: 'Too many sign-in attempts. Try again in 15 minutes.' });
  activeLogins++;
  let released = false;
  const release = () => { if (!released) { released = true; activeLogins--; } };
  res.once('finish', release);
  res.once('close', release);
  entry.count++;
  attempts.set(key, entry);
  next();
}
function safeguards(req, res, next) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    // JSON-only mutations cannot be submitted by cross-origin HTML forms.
    // Browser fetches must also pass the same-origin check, including login.
    const expected = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
    if ((req.get('origin') && req.get('origin') !== new URL(expected).origin) || req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ ok: false, error: 'Cross-site request refused.' });
    if (req.headers['content-length'] !== '0' && req.headers['content-length'] && !req.is('application/json')) return res.status(415).json({ ok: false, error: 'JSON requests are required.' });
  }
  next();
}
module.exports = { loginLimit, safeguards };
