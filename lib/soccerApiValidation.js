const { matches } = require('./toolValidation');
const { validDate } = require('./validation');
const soccer = require('./soccerLineup');
const rating = { type: 'integer', minimum: 1, maximum: 5 };
const player = { type: 'object', properties: { name: { type: 'string' }, offense: rating, defense: rating, goalie: rating } };
const game = structuredClone(soccer.SET_GAME_LINEUP_TOOL.function.parameters);
game.properties.rotationBoost = { type: 'number', minimum: 0.1, maximum: 5 };
game.properties.draftId = { type: 'string' };
function validateSoccer(req, res, next) {
  if (['GET', 'HEAD'].includes(req.method)) return next();
  const body = req.body || {};
  const schema = req.path.includes('/roster/players') ? { ...player, ...(req.method === 'POST' ? { required: ['name'] } : {}) }
    : req.path === '/roster/settings' ? soccer.UPDATE_LINEUP_SETTINGS_TOOL.function.parameters : game;
  let valid = matches(body, schema);
  if (body.date !== undefined && !validDate(body.date)) valid = false;
  for (const map of [body.resting, body.pinned]) if (map && Object.keys(map).some(q => !/^[1-4]$/.test(q))) valid = false;
  if (body.pinned && Object.values(body.pinned).some(pins => !pins || typeof pins !== 'object' || Object.values(pins).some(position => !require('./soccerFormations').normalizePositionToken(position)))) valid = false;
  if (!valid) return res.status(400).json({ ok: false, error: 'Invalid soccer request. Check the date, ratings, quarter numbers and settings.' });
  next();
}
module.exports = { validateSoccer };
