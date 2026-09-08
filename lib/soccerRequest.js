// Parse only complete, supported command clauses. Never forward arbitrary free
// text, historical messages, facts, attachment text, or saved warnings to AI.
const { scrubText } = require('./soccerPrivacy');
const positions = '(?:goalkeeper|goalie|keeper|defense|defender|midfield|midfielder|forward|striker|(?:left|right|center) (?:back|wing|mid|midfield|midfielder|forward))';
const quarter = '(?:q[1-4]|(?:the )?(?:first|second|third|fourth|[1-4]) quarter|(?:the )?(?:first|second) half|all (?:four|4) quarters)';
const patterns = [
  /^(?:please )?(?:set(?: up)?|create|generate|schedule|make)(?: me)? (?:a |the |today's |this week's |next week's )?(?:game |soccer )?lineup(?: for (?:today|tomorrow|saturday|sunday|\d{4}-\d{2}-\d{2}))?(?: (?:in|using|with)(?: a)? [23]-[123]-[12](?: formation)?)?$/i,
  new RegExp(`^(?:please )?rest Player_\\d+(?: (?:in|for))? ${quarter}$`, 'i'),
  new RegExp(`^(?:please )?(?:put|play|pin) Player_\\d+ (?:at|in|as)(?: a)? ${positions}(?: (?:in|for))? ${quarter}$`, 'i'),
  /^(?:please )?(?:bump|set|change|update) Player_\d+(?:'s)? (?:offense|defense|goalie) to (?:a )?[1-5]$/i,
  /^(?:please )?remove Player_\d+$/i,
  /^(?:please )?(?:give me |generate |try )?(?:another option|a different (?:one|option))$/i,
  /^rotate positions more than last game$/i,
  /^(?:please )?(?:use this lineup|mark this lineup used|lock it in)$/i,
  /^(?:please )?ignore (?:all )?side preferences for this (?:lineup|game)$/i,
  /^(?:please )?(?:make|save|set) (?:the )?(?:weaker|lower-average) (?:defenders?|midfielders?|forwards?) (?:on |at )?(?:the )?(?:left|right|none)(?: (?:as )?my new default| (?:as )?my default)$/i,
  /^(?:for this (?:game|lineup),? )?(?:put|play) (?:the )?(?:weaker|lower-average) (?:defender|midfielder|forward) (?:on|at) (?:the )?(?:left|right)$/i,
  /^(?:hello|hi|what can you do|help)$/i,
];
function controlledRequest(text, ctx) {
  if (typeof text !== 'string' || text.length > 4000 || /Player_\d+/i.test(text) || /\[Attached document:/.test(text)) return null;
  if ([...text.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)].some(match => !require('./validation').validDate(match[0]))) return null;
  const result = scrubText(text.normalize('NFC'), ctx);
  if (result.ambiguousNames.size) return null;
  const clauses = result.text.trim().replace(/[.!?]+$/, '').split(/\s*(?:;|\band also\b|\band\b)\s*/i);
  if (!clauses.length || clauses.length > 8 || clauses.some(clause => !patterns.some(pattern => pattern.test(clause)))) return null;
  // Rebuild from parsed clauses; no history or surrounding prose survives.
  return clauses.join('; ');
}
module.exports = { controlledRequest };
function permitsTool(canonical, name) {
  const clauses = canonical.split('; ').map(clause => clause.replace(/^please /i, ''));
  const expressions = {
    manage_roster: /^(bump|set|change|update|remove) Player_\d+/i,
    update_lineup_settings: /^(make|save|set) .*default$/i,
    finalize_lineup: /^(use this lineup|mark this lineup used|lock it in)$/i,
    generate_lineup_alternative: /another option|different (one|option)|^rotate positions more/i,
    set_game_lineup: /^(create|generate|schedule|make|set(?: up)?) .*lineup|^(rest|put|play|pin) Player_\d+|^ignore .*side preferences|^(for this (game|lineup),? )?(put|play) .*weaker/i,
  };
  return !!expressions[name] && clauses.some(clause => expressions[name].test(clause));
}
module.exports.permitsTool = permitsTool;
