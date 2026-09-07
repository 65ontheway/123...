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
      'game they mean, ask them to clarify instead of guessing at a gameId.',
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
  return typeof value === 'string' && DATE_RE.test(value);
}

module.exports = { GENERATE_LINEUP_ALTERNATIVE_TOOL, FINALIZE_LINEUP_TOOL, isValidDateString };
