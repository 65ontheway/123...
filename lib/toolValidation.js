// Runtime validation of the actual advertised schema subset, with tighter
// bounds and no unknown properties unless explicitly declared as a map.
function matches(value, schema, depth = 0) {
  if (depth > 8) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 100) return false;
    if ((schema.required || []).some(key => !Object.hasOwn(value, key))) return false;
    return Object.entries(value).every(([key, item]) => {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) return false;
      const child = schema.properties?.[key] || (typeof schema.additionalProperties === 'object' ? schema.additionalProperties : null);
      return child && matches(item, child, depth + 1);
    });
  }
  if (schema.type === 'array') return Array.isArray(value) && value.length <= 100 && value.every(item => matches(item, schema.items, depth + 1));
  if (schema.type === 'string') return typeof value === 'string' && value.length <= 200;
  if (schema.type === 'boolean') return typeof value === 'boolean';
  if (schema.type === 'integer' || schema.type === 'number') return typeof value === 'number' && Number.isFinite(value) && (schema.type !== 'integer' || Number.isInteger(value)) && (schema.minimum == null || value >= schema.minimum) && (schema.maximum == null || value <= schema.maximum);
  return false;
}
// Validates a single call against its declared schema, independent of the
// rest of the batch (id/operation de-duplication is a batch-level concern,
// handled by validateToolCallsDetailed below). Returns the parsed args
// alongside a pass/fail so a caller doesn't need to re-parse JSON that's
// already known to be valid.
function validateOneToolCall(call, tools, ctx) {
  const tool = tools.find(tool => tool.function.name === call.function?.name);
  if (!tool) return { valid: false, reason: 'not a recognized action' };
  if (typeof call.id !== 'string' || call.id.length > 200) return { valid: false, reason: 'malformed call id' };
  if (typeof call.function.arguments !== 'string' || call.function.arguments.length > 16000) return { valid: false, reason: 'arguments were missing or too large' };
  let args;
  try { args = JSON.parse(call.function.arguments); } catch { return { valid: false, reason: 'arguments were not valid JSON' }; }
  if (!matches(args, tool.function.parameters)) return { valid: false, reason: 'arguments did not match the expected shape' };
  if (args.date && !require('./validation').validDate(args.date)) return { valid: false, reason: `"${args.date}" is not a valid date` };
  // A bad quarter key or an unrecognized pinned position is deliberately
  // NOT checked here, unlike everything above — soccerPrivacy.js's
  // translateSchedulingArgsToIds (quarter keys) and soccerScheduling.js's
  // own pin-processing (position tokens) already handle exactly these,
  // per-entry, by dropping just that one piece with a specific warning
  // ("Q3: ... isn't a valid quarter", "... isn't a position or role this
  // app recognizes"). Rejecting the WHOLE call here instead would throw
  // away every other correctly-specified pin/resting entry over one bad
  // one — e.g. a coach's "bench" phrasing landing in `pinned` instead of
  // `resting` would previously wipe out an entire multi-player, multi-
  // quarter request with a single generic error and nothing changed.
  const labels = [...Object.values(args.resting || {}).flat(), ...Object.values(args.pinned || {}).flatMap(Object.keys), ...(args.remove || []), ...(args.update || []).map(x => x.name)];
  if (ctx && labels.some(label => !ctx.idByLabel.has(label))) return { valid: false, reason: 'referenced a player not on the roster' };
  return { valid: true, args };
}

// Per-call validation across a batch: unlike validateToolCalls (an
// all-or-nothing gate), this reports which specific calls failed and why,
// so a caller can execute whatever calls in the batch DID validate rather
// than discarding a whole multi-part request over one bad piece. Id and
// operation de-duplication is still batch-wide — a duplicate is reported
// against the later occurrence, keeping the first.
function validateToolCallsDetailed(calls, tools, ctx) {
  if (!Array.isArray(calls)) return [];
  if (calls.length > 8) return calls.map(call => ({ call, valid: false, reason: 'too many actions requested in a single turn' }));
  const ids = new Set();
  const operations = new Set();
  const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
  return calls.map(call => {
    const result = validateOneToolCall(call, tools, ctx);
    if (!result.valid) return { call, valid: false, reason: result.reason };
    if (ids.has(call.id)) return { call, valid: false, reason: 'duplicate call id' };
    ids.add(call.id);
    const operation = call.function.name + ':' + JSON.stringify(stable(result.args));
    if (operations.has(operation)) return { call, valid: false, reason: 'the same action was already proposed this turn' };
    operations.add(operation);
    return { call, valid: true, reason: null, args: result.args };
  });
}

function validateToolCalls(calls, tools, ctx) {
  if (!Array.isArray(calls) || calls.length > 8) return false;
  return validateToolCallsDetailed(calls, tools, ctx).every(result => result.valid);
}
module.exports = { matches, validateToolCalls, validateToolCallsDetailed };
