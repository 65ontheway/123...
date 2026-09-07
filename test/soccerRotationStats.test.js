const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_HISTORY_WINDOW,
  selectRecentFinalizedGames,
  buildRotationStats,
  rotationScoreFor,
  rotationWeight,
} = require('../lib/soccerRotationStats');

// Fictional, minimal "game" fixtures — just enough shape for this pure
// module to read (status/selectedDraftId/drafts/date/finalizedAt), no
// roster names or real IDs anywhere. Two quarters, two slots each, one
// bench player, is plenty to exercise role/position/bench counting.
function makeFinalizedGame({ date, finalizedAt, quarters }) {
  const draftId = 'd-' + date + '-' + finalizedAt;
  return {
    date,
    finalizedAt,
    status: 'finalized',
    selectedDraftId: draftId,
    drafts: { [draftId]: { result: { quarters } } },
  };
}

function q(quarter, lineup, bench) {
  return { quarter, lineup, bench };
}

test('soccerRotationStats.js', async (t) => {
  await t.test('selectRecentFinalizedGames excludes drafts and games with no selected draft result', () => {
    const finalized = makeFinalizedGame({ date: '2024-01-01', finalizedAt: 'a', quarters: [] });
    const draftOnly = { date: '2024-01-02', status: 'draft', selectedDraftId: 'x', drafts: { x: { result: { quarters: [] } } } };
    const brokenSelection = { date: '2024-01-03', status: 'finalized', selectedDraftId: 'missing', drafts: {} };
    const result = selectRecentFinalizedGames([finalized, draftOnly, brokenSelection], 4);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0], finalized);
  });

  await t.test('selectRecentFinalizedGames sorts most-recent-first by date, then finalizedAt', () => {
    const g1 = makeFinalizedGame({ date: '2024-01-01', finalizedAt: 't1', quarters: [] });
    const g2 = makeFinalizedGame({ date: '2024-02-01', finalizedAt: 't1', quarters: [] });
    const g3 = makeFinalizedGame({ date: '2024-02-01', finalizedAt: 't2', quarters: [] });
    const result = selectRecentFinalizedGames([g1, g2, g3], 4);
    assert.deepStrictEqual(result, [g3, g2, g1]);
  });

  await t.test('selectRecentFinalizedGames bounds to the given window size', () => {
    const games = Array.from({ length: 6 }, (_, i) =>
      makeFinalizedGame({ date: `2024-01-0${i + 1}`, finalizedAt: 't', quarters: [] })
    );
    assert.strictEqual(selectRecentFinalizedGames(games, 4).length, 4);
    assert.strictEqual(selectRecentFinalizedGames(games, 0).length, 0);
  });

  await t.test('DEFAULT_HISTORY_WINDOW is 4', () => {
    assert.strictEqual(DEFAULT_HISTORY_WINDOW, 4);
  });

  await t.test('buildRotationStats tallies role, exact-position, and bench counts from stored results only', () => {
    const game = makeFinalizedGame({
      date: '2024-03-01',
      finalizedAt: 't',
      quarters: [
        q(1, [{ position: 'left_back', role: 'defender', playerId: 'p1' }], ['p2']),
        q(2, [{ position: 'right_back', role: 'defender', playerId: 'p1' }], ['p2']),
      ],
    });
    const stats = buildRotationStats([game], { windowSize: 4 });
    assert.strictEqual(stats.gamesConsidered, 1);
    const p1 = stats.statsByPlayerId.get('p1');
    assert.strictEqual(p1.roleCounts.defender, 2);
    assert.strictEqual(p1.positionCounts.left_back, 1);
    assert.strictEqual(p1.positionCounts.right_back, 1);
    assert.strictEqual(p1.benchCount, 0);
    assert.strictEqual(p1.gamesCounted, 1);
    const p2 = stats.statsByPlayerId.get('p2');
    assert.strictEqual(p2.benchCount, 2, 'benched both counted quarters');
    assert.strictEqual(p2.roleCounts.defender, 0);
  });

  await t.test('buildRotationStats only considers the most recent windowSize finalized games', () => {
    const games = Array.from({ length: 5 }, (_, i) =>
      makeFinalizedGame({
        date: `2024-04-0${i + 1}`,
        finalizedAt: 't',
        quarters: [q(1, [{ position: 'left_back', role: 'defender', playerId: 'oldTimer' }], [])],
      })
    );
    const stats = buildRotationStats(games, { windowSize: 4 });
    assert.strictEqual(stats.gamesConsidered, 4);
    assert.strictEqual(stats.statsByPlayerId.get('oldTimer').roleCounts.defender, 4, 'the 5th (oldest) game must not count');
  });

  await t.test('a player absent from a counted game is never touched for it — no phantom bench credit for a missed game', () => {
    const game = makeFinalizedGame({
      date: '2024-05-01',
      finalizedAt: 't',
      quarters: [q(1, [{ position: 'left_back', role: 'defender', playerId: 'p1' }], [])],
    });
    const stats = buildRotationStats([game], { windowSize: 4 });
    assert.strictEqual(stats.statsByPlayerId.has('neverInThisGame'), false);
    assert.strictEqual(rotationScoreFor('neverInThisGame', 'defender', 'left_back', stats), 0);
  });

  await t.test('rotationScoreFor: a brand-new player with no history scores 0 (neutral, most eligible)', () => {
    const stats = buildRotationStats([], { windowSize: 4 });
    assert.strictEqual(rotationScoreFor('brandNew', 'defender', 'left_back', stats), 0);
  });

  await t.test('rotationScoreFor: recent role+position experience raises the score; recent bench time lowers it, floored at 0', () => {
    const game = makeFinalizedGame({
      date: '2024-06-01',
      finalizedAt: 't',
      quarters: [
        q(1, [{ position: 'left_back', role: 'defender', playerId: 'veteran' }], ['bencher']),
        q(2, [{ position: 'left_back', role: 'defender', playerId: 'veteran' }], ['bencher']),
        q(3, [{ position: 'left_back', role: 'defender', playerId: 'veteran' }], ['bencher']),
      ],
    });
    const stats = buildRotationStats([game], { windowSize: 4 });
    const veteranScore = rotationScoreFor('veteran', 'defender', 'left_back', stats);
    const bencherScore = rotationScoreFor('bencher', 'defender', 'left_back', stats);
    assert.ok(veteranScore > 0, 'heavy recent role+position experience should score above 0');
    assert.strictEqual(bencherScore, 0, 'a heavily benched player scores no lower than the floor of 0');
    assert.ok(veteranScore > bencherScore, 'the rotation score should prefer benching the veteran over the already-benched player');
  });

  await t.test('rotationWeight: lower score means higher weight, monotonically', () => {
    assert.ok(rotationWeight(0) > rotationWeight(1));
    assert.ok(rotationWeight(1) > rotationWeight(5));
    assert.ok(rotationWeight(0) === 1, 'a score of 0 with default boost should have weight 1 (1/(1+0))');
  });

  await t.test('rotationWeight: rotationBoost sharpens the penalty for a positive score without affecting a 0 score', () => {
    assert.strictEqual(rotationWeight(0, 3), 1, 'boost never changes the weight for an already-fresh (score 0) candidate');
    assert.ok(rotationWeight(2, 3) < rotationWeight(2, 1), 'a higher boost should penalize a nonzero score more');
  });

  await t.test('rotationWeight tolerates a negative rotationBoost by clamping it to 0 (no penalty, not a crash)', () => {
    assert.strictEqual(rotationWeight(4, -5), 1);
  });
});
