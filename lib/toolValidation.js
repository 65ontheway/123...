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
function validateToolCalls(calls, tools, ctx) {
  if (!Array.isArray(calls) || calls.length > 8) return false;
  const ids = new Set();
  const operations = new Set();
  const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
  return calls.every(call => {
    const tool = tools.find(tool => tool.function.name === call.function?.name);
    if (!tool || typeof call.id !== 'string' || call.id.length > 200 || ids.has(call.id) || typeof call.function.arguments !== 'string' || call.function.arguments.length > 16000) return false;
    ids.add(call.id);
    let args;
    try { args = JSON.parse(call.function.arguments); } catch { return false; }
    if (!matches(args, tool.function.parameters)) return false;
    const operation = call.function.name + ':' + JSON.stringify(stable(args));
    if (operations.has(operation)) return false;
    operations.add(operation);
    if (args.date && !require('./validation').validDate(args.date)) return false;
    for (const map of [args.resting, args.pinned]) if (map && Object.keys(map).some(q => !/^[1-4]$/.test(q))) return false;
    if (Object.values(args.pinned || {}).some(pins => Object.values(pins).some(position => !require('./soccerFormations').normalizePositionToken(position)))) return false;
    const labels = [...Object.values(args.resting || {}).flat(), ...Object.values(args.pinned || {}).flatMap(Object.keys), ...(args.remove || []), ...(args.update || []).map(x => x.name)];
    if (ctx && labels.some(label => !ctx.idByLabel.has(label))) return false;
    return true;
  });
}
module.exports = { matches, validateToolCalls };
