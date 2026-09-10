const { AsyncLocalStorage } = require('node:async_hooks');
const context = new AsyncLocalStorage();
const accounts = new Map();
let active = 0;
function requestScope(req, res, next) {
  const owner = req.session.ownerId;
  const now = Date.now();
  let budget = accounts.get(owner);
  if (!budget || budget.until <= now) { budget = { count: 0, active: 0, reserved: 0, until: now + 24 * 60 * 60_000 }; accounts.set(owner, budget); }
  if (budget.active >= 1 || active >= 4) return res.status(429).json({ ok: false, error: 'Wait for the current reply before starting another AI request.' });
  budget.active++; active++;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  let released = false;
  const release = () => { if (released) return; released = true; clearTimeout(timer); controller.abort(); budget.active--; active--; };
  res.once('close', release);
  res.once('finish', release);
  context.run({ signal: controller.signal, calls: 0 }, next);
}
async function providerFetch(url, options = {}) {
  const scope = context.getStore();
  if (scope && ++scope.calls > 3) throw new Error('Provider call limit reached');
  const signal = AbortSignal.any([AbortSignal.timeout(90_000), ...(scope ? [scope.signal] : []), ...(options.signal ? [options.signal] : [])]);
  const body = JSON.parse(options.body);
  body.provider = { require_parameters: true, max_price: { prompt: 5, completion: 20 } };
  body.max_tokens = Math.min(body.max_tokens || 4000, 4000);
  const response = await fetch(url, { ...options, body: JSON.stringify(body), signal });
  let bytes = 0;
  const limited = response.body?.pipeThrough(new TransformStream({ transform(chunk, controller) {
    bytes += chunk.byteLength;
    if (bytes > 2 * 1024 * 1024) { controller.error(new Error('Provider output limit reached')); return; }
    controller.enqueue(chunk);
  } }));
  return new Response(limited, { status: response.status, headers: response.headers });
}
module.exports = { providerFetch, requestScope };

module.exports.throwIfCancelled = () => context.getStore()?.signal.throwIfAborted();
