// The two model-facing tool schemas for scheduling a game
// (set_game_lineup, update_lineup_settings) — split out of
// soccerScheduling.js per CLAUDE.md's file-size guidance. Pure schema
// definitions, no logic; soccerScheduling.js re-exports both unchanged so
// every existing require site (soccerLineup.js, soccerApiValidation.js,
// soccerLineupChat.js) keeps working without any change.
const formations = require('./soccerFormations');
const { FORMATIONS, DEFAULT_FORMATION } = formations;

// The tool definition sent to OpenRouter. The model's job is limited to
// filling this in from the coach's message — it never sees or computes the
// actual player assignments. Constraints are keyed by quarter number
// ("1"-"4") since AYSO allows a free substitution between each quarter.
const SET_GAME_LINEUP_TOOL = {
  type: 'function',
  function: {
    name: 'set_game_lineup',
    description:
      'Record the constraints for a full 4-quarter 7v7 soccer game from the coach\'s request, and save it as a ' +
      'new DRAFT lineup the coach can review, regenerate, or finalize. Does not compute the lineup itself — the ' +
      'app schedules the actual game from these constraints, including AYSO\'s rule that every player plays 3 ' +
      'quarters before anyone plays a 4th, the coach\'s left/right side preferences (unless overridden here for ' +
      'this lineup only), and rotation away from what recent finalized games already covered. Always creates a ' +
      'brand-new saved game — for "another option" or "use this lineup" on an EXISTING one, use ' +
      'generate_lineup_alternative / finalize_lineup instead, referencing that game\'s id.',
    parameters: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: 'The game date in YYYY-MM-DD form, if the coach named or implied one (e.g. "Saturday"). Omit to use today.',
        },
        formation: {
          type: 'string',
          enum: Object.keys(FORMATIONS),
          description: `Formation to use for the whole game. Omit to use the roster's own default (${DEFAULT_FORMATION} if it doesn't set one).`,
        },
        resting: {
          type: 'object',
          description:
            'Map of quarter number ("1"-"4") to the names of players sitting out that quarter. ' +
            '"first half" means quarters 1 and 2; "second half" means quarters 3 and 4.',
          additionalProperties: { type: 'array', items: { type: 'string' } },
        },
        pinned: {
          type: 'object',
          description:
            'Map of quarter number ("1"-"4") to a map of {"Player Name": "position"} for players the coach ' +
            'explicitly assigned that quarter. Position can be an exact slot (e.g. "left_back", "center_mid", ' +
            '"striker" — common aliases like "goalie" and "center midfield" are also fine) to assign that ' +
            'exact spot, or a general role ("goalkeeper", "defender", "midfielder", "forward" — e.g. "play ' +
            'Player_2 in defense") to let the app pick which exact slot within that role, applying the side ' +
            'preference below. Only use an exact slot when the coach named one specifically — a general role ' +
            'request should stay general so the side preference still applies. Sitting out / benching a ' +
            'player for a quarter is NEVER a pinned position — use `resting` for that instead, even when the ' +
            'coach phrases it the same way as a position pin ("X should be on the bench in Q3").',
          additionalProperties: {
            type: 'object',
            additionalProperties: { type: 'string' },
          },
        },
        sideOverrides: {
          type: 'object',
          description:
            'Per-role left/right side preference for THIS LINEUP ONLY — never changes the coach\'s saved ' +
            'defaults (use update_lineup_settings for that instead). Omit a role entirely to use the coach\'s ' +
            'saved default for it. Set a role to "none" to explicitly turn off its preference for this lineup ' +
            'only (different from omitting it). Only set this when the coach said something like "for this ' +
            'game" / "just this once" / "this lineup" about a side preference.',
          properties: {
            defender: { type: 'string', enum: ['left', 'right', 'none'] },
            midfielder: { type: 'string', enum: ['left', 'right', 'none'] },
            forward: { type: 'string', enum: ['left', 'right', 'none'] },
          },
        },
        ignoreSidePreferences: {
          type: 'boolean',
          description:
            'Set true when the coach wants ALL side preferences turned off for this one lineup (e.g. "ignore ' +
            'side preferences for this game"), without changing their saved defaults. Equivalent to setting ' +
            'every role in sideOverrides to "none" — only needed as a shortcut when no specific roles were named.',
        },
      },
      required: [],
    },
  },
};

// Lets a coach persist their default side preferences for FUTURE lineups —
// kept as a separate tool from set_game_lineup on purpose, so a plain
// scheduling request can never accidentally change a saved default, and so
// a single turn that both saves a preference AND asks for a lineup ("make
// weaker defenders left my default, then schedule the game") produces two
// distinct, individually-inspectable tool calls rather than one that tries
// to do both. Only ever called when the coach explicitly asks to save or
// change a default — never for a "this lineup only" request (that's
// set_game_lineup's sideOverrides/ignoreSidePreferences instead).
const UPDATE_LINEUP_SETTINGS_TOOL = {
  type: 'function',
  function: {
    name: 'update_lineup_settings',
    description:
      'Persist the coach\'s default left/right side preference for one or more roles, for all FUTURE ' +
      'lineups. Does not generate or affect a lineup for the current request by itself — call ' +
      'set_game_lineup too (in the same turn) if the coach also asked for a lineup. Only include the ' +
      'role(s) the coach explicitly asked to change; every role left out keeps its current saved value.',
    parameters: {
      type: 'object',
      properties: {
        defender: {
          type: 'string',
          enum: ['left', 'right', 'none'],
          description: 'Which side the lower-average defender should default to. "none" means no preference.',
        },
        midfielder: {
          type: 'string',
          enum: ['left', 'right', 'none'],
          description: 'Which side the lower-average midfielder/wing should default to.',
        },
        forward: {
          type: 'string',
          enum: ['left', 'right', 'none'],
          description: 'Which side the lower-average forward should default to.',
        },
      },
      required: [],
    },
  },
};

module.exports = { SET_GAME_LINEUP_TOOL, UPDATE_LINEUP_SETTINGS_TOOL };
