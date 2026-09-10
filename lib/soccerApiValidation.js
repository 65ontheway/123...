const { matches } = require('./toolValidation');
const { validDate } = require('./validation');
const soccer = require('./soccerLineup');
const rating = { type: 'integer', minimum: 1, maximum: 5 };
const player = { type: 'object', properties: { name: { type: 'string' }, offense: rating, defense: rating, goalie: rating } };
const game = structuredClone(soccer.SET_GAME_LINEUP_TOOL.function.parameters);
game.properties.rotationBoost = { type: 'number', minimum: 0.1, maximum: 5 };
game.properties.draftId = { type: 'string' };
// The roster panel's settings PUT also accepts `formation` — a roster-panel-
// only field, never part of the chat-facing update_lineup_settings tool
// (that tool is side preferences only), so it's layered on as a schema
// extension here rather than added to the shared tool definition itself.
const rosterSettings = structuredClone(soccer.UPDATE_LINEUP_SETTINGS_TOOL.function.parameters);
rosterSettings.properties.formation = { type: 'string', enum: Object.keys(soccer.FORMATIONS) };
// A backup file's own shape (see soccerRosterRoutes.js's /roster/export) —
// the nested `skills` object storage/export actually use, never the flat
// offense/defense/goalie the roster panel's create/update-player requests
// use, so a re-uploaded export round-trips through the exact shape it came
// out in.
const rosterImportPlayer = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    skills: {
      type: 'object',
      properties: { offense: rating, defense: rating, goalie: rating },
      required: ['offense', 'defense', 'goalie'],
    },
  },
  required: ['name', 'skills'],
};
const rosterImport = {
  type: 'object',
  properties: {
    // Deliberately not enum-restricted to today's FORMATIONS, unlike
    // roster/settings above — an unrecognized value here (an older
    // export, a hand-edited file) is the route handler's job to fall back
    // on gracefully, never a reason to reject an otherwise-valid restore
    // at this layer.
    formation: { type: 'string' },
    players: { type: 'array', items: rosterImportPlayer },
  },
  required: ['players'],
};
function validateSoccer(req, res, next) {
  if (['GET', 'HEAD'].includes(req.method)) return next();
  const body = req.body || {};
  const schema = req.path.includes('/roster/players') ? { ...player, ...(req.method === 'POST' ? { required: ['name'] } : {}) }
    : req.path === '/roster/settings' ? rosterSettings
    : req.path === '/roster/import' ? rosterImport
    : game;
  let valid = matches(body, schema);
  if (body.date !== undefined && !validDate(body.date)) valid = false;
  for (const map of [body.resting, body.pinned]) if (map && Object.keys(map).some(q => !/^[1-4]$/.test(q))) valid = false;
  if (body.pinned && Object.values(body.pinned).some(pins => !pins || typeof pins !== 'object' || Object.values(pins).some(position => !require('./soccerFormations').normalizePositionToken(position)))) valid = false;
  if (!valid) return res.status(400).json({ ok: false, error: 'Invalid soccer request. Check the date, ratings, quarter numbers and settings.' });
  next();
}
module.exports = { validateSoccer };
