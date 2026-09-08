function summarizeActions(calls, ctx, selectedGame) {
  const name = label => ctx.nameByLabel.get(label) || 'unresolved player';
  const constraints = args => [
    ...Object.entries(args.resting || {}).flatMap(([q, players]) => players.map(label => `Rest ${name(label)} in Q${q}.`)),
    ...Object.entries(args.pinned || {}).flatMap(([q, pins]) => Object.entries(pins).map(([label, position]) => `Play ${name(label)} at ${position.replaceAll('_', ' ')} in Q${q}.`)),
    ...Object.entries(args.sideOverrides || {}).map(([role, side]) => `For this option, ${role} side preference: ${side}.`),
    ...(args.ignoreSidePreferences ? ['Ignore side preferences for this option.'] : []),
    ...(args.rotateMore ? ['Increase rotation for this option.'] : []),
  ].join(' ');
  return calls.map(call => {
    const args = JSON.parse(call.function.arguments);
    switch (call.function.name) {
      case 'manage_roster': return [
        ...(args.update || []).map(player => `Update ${name(player.name)}: ${['offense', 'defense', 'goalie'].filter(key => player[key] != null).map(key => `${key} to ${player[key]}`).join(', ')}.`),
        ...(args.remove || []).map(label => `Remove ${name(label)} from the roster.`),
      ].join('\n');
      case 'update_lineup_settings': return 'Save new defaults: ' + Object.entries(args).map(([role, side]) => `${role}: ${side}`).join(', ') + '.';
      case 'finalize_lineup': return `Mark the lineup for ${selectedGame.date} used (option ${selectedGame.selectedDraftId.slice(0, 8)}). This will count toward rotation history.`;
      case 'generate_lineup_alternative': return `Generate another option for ${selectedGame.date}. The game will be a draft until marked used. ${constraints(args)}`;
      case 'set_game_lineup': return `Create a new draft for ${args.date || 'today'}. ${constraints(args)}`;
      default: return 'Unsupported action.';
    }
  }).join('\n');
}
module.exports = { summarizeActions };
