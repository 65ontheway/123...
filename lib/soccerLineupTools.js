// Tool schemas for the two draft/history actions chat can trigger without
// generating a fresh lineup from scratch — "give me another option" and
// "use this lineup." Split out from soccerScheduling.js (which owns the
// tool that actually creates a new game) and soccerLineupHistory.js (which
// is storage/logic, not tool-schema definitions) so neither grows past
// CLAUDE.md's ~500-line guidance.
//
// Both require a `gameId` the model must have seen earlier in this same
// conversation (the app's own prior replies always mention it in plain
// text, in the label-only space the model already operates in — a game id
// is an opaque identifier, not a player name, so it's never anonymized or
// scrubbed). Neither tool ever creates a new game on its own; an
// unresolvable gameId is reported back as a tool result the model can
// explain, never guessed at.
const GENERATE_LINEUP_ALTERNATIVE_TOOL = {
  type: 'function',
  function: {
    name: 'generate_lineup_alternative',
    description:
      'Generate another option for an EXISTING saved game — same roster snapshot, constraints, and settings ' +
      'that game started with, just a different arrangement. Never creates a new game. Only call this when the ' +
      'coach clearly means an already-generated lineup from earlier in this conversation (e.g. "give me another ' +
      'option," "try a different one," "rotate positions more than last game"); if you cannot tell which saved ' +
      'game they mean, ask them to clarify instead of guessing at a gameId. If the coach adds a specific ' +
      'constraint for this regeneration (e.g. "make sure Player_2 plays defense at some point," "rest Player_4 ' +
      'in the third quarter"), pass it via resting/pinned/sideOverrides below rather than dropping it or ' +
      'creating a brand-new game — these apply to this one regeneration only, on top of the game\'s existing ' +
      'constraints, and are never saved as new defaults.',
    parameters: {
      type: 'object',
      properties: {
        gameId: {
          type: 'string',
          description: 'The game reference id (mentioned in an earlier reply in this conversation) to generate another option for.',
        },
        rotateMore: {
          type: 'boolean',
          description:
            'Set true ONLY when the coach explicitly asks for more rotation/variety than usual (e.g. "rotate ' +
            'positions more than last game," "mix it up more"). Temporary — applies to this one regeneration ' +
            'only, never changes any saved default.',
        },
        resting: {
          type: 'object',
          description:
            'Optional, ADDITIONAL to this game\'s existing resting constraints — map of quarter number ("1"-"4") ' +
            'to the names of players who should also sit out that quarter for this regeneration only. Omit ' +
            'entirely for a plain "give me another option" with no new constraint.',
          additionalProperties: { type: 'array', items: { type: 'string' } },
        },
        pinned: {
          type: 'object',
          description:
            'Optional, ADDITIONAL to this game\'s existing pins — map of quarter number ("1"-"4") to a map of ' +
            '{"Player Name": "position"} for this regeneration only. Position can be an exact slot (e.g. ' +
            '"left_back") or a general role (e.g. "defender") — use a general role when the coach only said ' +
            'which broad role/side of the ball, not an exact spot (e.g. "Player_2 needs to play some defense" ' +
            '-> pin Player_2 to "defender" in whichever quarter makes sense, not a specific back position). ' +
            'Omit entirely for a plain "give me another option" with no new constraint.',
          additionalProperties: {
            type: 'object',
            additionalProperties: { type: 'string' },
          },
        },
        sideOverrides: {
          type: 'object',
          description:
            'Optional per-role left/right side preference for THIS regeneration only, on top of the game\'s ' +
            'existing settings — same shape as set_game_lineup\'s sideOverrides. Omit unless the coach asked for ' +
            'a side change specifically for this regeneration.',
          properties: {
            defender: { type: 'string', enum: ['left', 'right', 'none'] },
            midfielder: { type: 'string', enum: ['left', 'right', 'none'] },
            forward: { type: 'string', enum: ['left', 'right', 'none'] },
          },
        },
        ignoreSidePreferences: {
          type: 'boolean',
          description: 'Set true to turn off all side preferences for this regeneration only, without changing any saved default.',
        },
      },
      required: ['gameId'],
    },
  },
};

const FINALIZE_LINEUP_TOOL = {
  type: 'function',
  function: {
    name: 'finalize_lineup',
    description:
      'Mark a saved lineup as the one actually used for that game (e.g. "use this lineup," "that\'s the one for ' +
      'Saturday," "lock it in"). Only finalized lineups ever count toward future rotation history — a draft, or ' +
      'any option the coach didn\'t choose, never does, no matter how many times it was regenerated. Only call ' +
      'this when the coach clearly refers to an already-generated lineup; ask for clarification if it\'s unclear ' +
      'which saved game or which of its options they mean.',
    parameters: {
      type: 'object',
      properties: {
        gameId: { type: 'string', description: 'The game reference id to finalize.' },
      },
      required: ['gameId'],
    },
  },
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isValidDateString(value) {
  return require('./validation').validDate(value);
}

module.exports = { GENERATE_LINEUP_ALTERNATIVE_TOOL, FINALIZE_LINEUP_TOOL, isValidDateString };
