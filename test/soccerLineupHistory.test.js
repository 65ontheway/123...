// Focused coverage for lib/soccerLineupHistory.js — the private draft/game
// storage layer: reopening never recomputes, finalize/replace/undo are
// idempotent and never double-count, drafts never influence rotation
// history, frozen inputs survive a live roster/formation change, and
// account isolation holds. Fictional data only, own temp RAYGPT_DATA_DIR
// (never the real roster location), same convention every other test file
// in this suite uses.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

process.env.RAYGPT_DATA_DIR = path.join(os.tmpdir(), 'raygpt-test-lineup-history-' + process.pid);
process.env.RAYGPT_LEGACY_ROSTER_DIR = path.join(process.env.RAYGPT_DATA_DIR, 'isolated-legacy');

const soccerLineup = require('../lib/soccerLineup');
const scheduling = require('../lib/soccerScheduling');
const rotationStatsLib = require('../lib/soccerRotationStats');
const history = require('../lib/soccerLineupHistory');

function seedRoster(username, formation = '2-3-1') {
  const roster = { formation, players: [] };
  const specs = [
    { name: 'Fixture Keeper', offense: 1, defense: 1, goalie: 5 },
    { name: 'Fixture Back A', offense: 1, defense: 5, goalie: 1 },
    { name: 'Fixture Back B', offense: 1, defense: 4, goalie: 1 },
    { name: 'Fixture Mid A', offense: 2, defense: 2, goalie: 1 },
    { name: 'Fixture Mid B', offense: 2, defense: 2, goalie: 1 },
    { name: 'Fixture Mid C', offense: 1, defense: 1, goalie: 1 },
    { name: 'Fixture Fwd A', offense: 2, defense: 1, goalie: 1 },
  ];
  const players = specs.map((s) => soccerLineup.addPlayerDirect(roster, s));
  soccerLineup.saveRoster(username, roster);
  return { roster, players };
}

test('soccerLineupHistory.js', async (t) => {
  t.before(() => {
    soccerLineup.initRosterStorage();
    history.initLineupHistoryStorage();
  });

  await t.test('createGame produces a draft whose stored result matches computeGameLineup for the recorded seed', async () => {
    const { roster } = seedRoster('lhCoachA');
    const game = await history.withLineupLock('lhCoachA', () => history.createGame('lhCoachA', roster, { date: '2024-09-01' }));
    assert.strictEqual(game.status, 'draft');
    assert.strictEqual(game.date, '2024-09-01');
    assert.strictEqual(game.selectedDraftId, game.draftOrder[0]);
    const draft = game.drafts[game.selectedDraftId];
    const recomputed = scheduling.computeGameLineup(roster, {
      formation: game.frozenInputs.formation,
      seed: draft.seed,
    });
    const sig = (r) => r.quarters.map((q) => q.lineup.map((s) => `${s.position}:${s.player ? s.player.id : ''}`).join(',')).join('|');
    // recomputed uses the SAME frozen roster object here, so its signature
    // should match the stored (id-only) result exactly.
    const storedSig = draft.result.quarters.map((q) => q.lineup.map((s) => `${s.position}:${s.playerId || ''}`).join(',')).join('|');
    assert.strictEqual(sig(recomputed), storedSig);
  });

  await t.test('getGame never recomputes a lineup — reopening is a pure read', async () => {
    const { roster } = seedRoster('lhCoachB');
    const created = await history.withLineupLock('lhCoachB', () => history.createGame('lhCoachB', roster, {}));
    const original = scheduling.computeGameLineup;
    let calls = 0;
    scheduling.computeGameLineup = (...args) => {
      calls += 1;
      return original(...args);
    };
    try {
      history.getGame('lhCoachB', created.gameId, roster);
      history.getGame('lhCoachB', created.gameId, roster);
      history.listGames('lhCoachB');
    } finally {
      scheduling.computeGameLineup = original;
    }
    assert.strictEqual(calls, 0, 'reopening/listing must never call computeGameLineup');
  });

  await t.test('getGame reports rosterChanged: false right after creation, true after a roster edit', async () => {
    const { roster } = seedRoster('lhCoachC');
    const created = await history.withLineupLock('lhCoachC', () => history.createGame('lhCoachC', roster, {}));
    assert.strictEqual(history.getGame('lhCoachC', created.gameId, roster).rosterChanged, false);
    const live = soccerLineup.loadRoster('lhCoachC');
    soccerLineup.updatePlayerDirect(live, live.players[0].id, { offense: 5 });
    soccerLineup.saveRoster('lhCoachC', live);
    assert.strictEqual(history.getGame('lhCoachC', created.gameId, live).rosterChanged, true);
  });

  await t.test('addAlternative reuses the FROZEN roster snapshot, unaffected by a live roster edit made afterward', async () => {
    const { roster, players } = seedRoster('lhCoachD');
    const created = await history.withLineupLock('lhCoachD', () => history.createGame('lhCoachD', roster, {}));
    const frozenBack = created.frozenInputs.rosterSnapshot.find((p) => p.id === players[1].id);
    assert.strictEqual(frozenBack.skills.defense, 5);

    const live = soccerLineup.loadRoster('lhCoachD');
    soccerLineup.updatePlayerDirect(live, players[1].id, { defense: 1 });
    soccerLineup.saveRoster('lhCoachD', live);

    const { game: afterAlt } = await history.withLineupLock('lhCoachD', () => history.addAlternative('lhCoachD', created.gameId, {}));
    assert.strictEqual(
      afterAlt.frozenInputs.rosterSnapshot.find((p) => p.id === players[1].id).skills.defense,
      5,
      'generating another option must keep scheduling against the ORIGINAL frozen ratings, not the live edit'
    );
  });

  await t.test('addAlternative applies a one-off constraintOverrides pin for just this attempt, without touching the game\'s frozen constraints', async () => {
    const { roster, players } = seedRoster('lhCoachConstraint');
    const midA = players.find((p) => p.name === 'Fixture Mid A');
    const created = await history.withLineupLock('lhCoachConstraint', () => history.createGame('lhCoachConstraint', roster, {}));
    assert.deepStrictEqual(created.frozenInputs.constraints.pinned, {}, 'sanity check: no pins on the original game');

    const { game: afterAlt } = await history.withLineupLock('lhCoachConstraint', () =>
      history.addAlternative('lhCoachConstraint', created.gameId, {
        constraintOverrides: { pinned: { 4: { [midA.id]: 'defender' } } },
      })
    );
    const draft = afterAlt.drafts[afterAlt.selectedDraftId];
    const q4Defender = draft.result.quarters[3].lineup.find((s) => s.role === 'defender' && s.playerId === midA.id);
    assert.ok(q4Defender, 'the override pin should have placed Mid A into a defender slot in Q4');
    assert.deepStrictEqual(afterAlt.frozenInputs.constraints.pinned, {}, 'the game\'s FROZEN constraints must stay untouched by a one-off override');
    assert.deepStrictEqual(draft.constraintOverrides, { pinned: { 4: { [midA.id]: 'defender' } } }, 'the draft should record which override it actually used, for transparency');
  });

  await t.test('addAlternative constraintOverrides are one-off, not sticky: the next plain "another option" call reverts to the frozen constraints', async () => {
    const { roster, players } = seedRoster('lhCoachConstraintB');
    const midA = players.find((p) => p.name === 'Fixture Mid A');
    const created = await history.withLineupLock('lhCoachConstraintB', () => history.createGame('lhCoachConstraintB', roster, {}));
    await history.withLineupLock('lhCoachConstraintB', () =>
      history.addAlternative('lhCoachConstraintB', created.gameId, { constraintOverrides: { pinned: { 1: { [midA.id]: 'goalkeeper' } } } })
    );
    const { game: plainAlt } = await history.withLineupLock('lhCoachConstraintB', () => history.addAlternative('lhCoachConstraintB', created.gameId, {}));
    const plainDraft = plainAlt.drafts[plainAlt.selectedDraftId];
    assert.strictEqual(plainDraft.constraintOverrides, undefined, 'a plain follow-up call must carry no leftover override');
    assert.deepStrictEqual(plainAlt.frozenInputs.constraints.pinned, {}, 'the game\'s frozen constraints must still be untouched');
  });

  await t.test('addAlternative constraintOverrides.resting is additive to (not a replacement of) the game\'s existing resting constraint', async () => {
    const { roster, players } = seedRoster('lhCoachConstraintC');
    const fwdA = players.find((p) => p.name === 'Fixture Fwd A');
    const midC = players.find((p) => p.name === 'Fixture Mid C');
    const created = await history.withLineupLock('lhCoachConstraintC', () =>
      history.createGame('lhCoachConstraintC', roster, { resting: { 1: [fwdA.id] } })
    );
    const { game: afterAlt } = await history.withLineupLock('lhCoachConstraintC', () =>
      history.addAlternative('lhCoachConstraintC', created.gameId, { constraintOverrides: { resting: { 1: [midC.id] } } })
    );
    const draft = afterAlt.drafts[afterAlt.selectedDraftId];
    const q1Playing = new Set(draft.result.quarters[0].lineup.filter((s) => s.playerId).map((s) => s.playerId));
    assert.ok(!q1Playing.has(fwdA.id), 'the game\'s original resting constraint must still apply');
    assert.ok(!q1Playing.has(midC.id), 'the override\'s additional resting constraint must also apply');
  });

  await t.test('addAlternative on an already-finalized game reverts it to draft (an unreviewed option never silently counts as played)', async () => {
    const { roster } = seedRoster('lhCoachE');
    const created = await history.withLineupLock('lhCoachE', () => history.createGame('lhCoachE', roster, {}));
    await history.withLineupLock('lhCoachE', () => history.finalizeGame('lhCoachE', created.gameId));
    const finalized = history.getGame('lhCoachE', created.gameId);
    assert.strictEqual(finalized.status, 'finalized');

    const { game: afterAlt } = await history.withLineupLock('lhCoachE', () => history.addAlternative('lhCoachE', created.gameId, {}));
    assert.strictEqual(afterAlt.status, 'draft');
    assert.strictEqual(afterAlt.finalizedAt, null);
  });

  await t.test('finalizeGame is idempotent: finalizing the same selected draft again leaves finalizedAt untouched', async () => {
    const { roster } = seedRoster('lhCoachF');
    const created = await history.withLineupLock('lhCoachF', () => history.createGame('lhCoachF', roster, {}));
    const { game: first } = await history.withLineupLock('lhCoachF', () => history.finalizeGame('lhCoachF', created.gameId));
    const firstFinalizedAt = first.finalizedAt;
    const { alreadyFinalized } = await history.withLineupLock('lhCoachF', () => history.finalizeGame('lhCoachF', created.gameId));
    assert.strictEqual(alreadyFinalized, true);
    const after = history.getGame('lhCoachF', created.gameId);
    assert.strictEqual(after.finalizedAt, firstFinalizedAt);
  });

  await t.test('finalizing a DIFFERENT draft for the same game replaces the selection instead of appending a second game', async () => {
    const { roster } = seedRoster('lhCoachG');
    const created = await history.withLineupLock('lhCoachG', () => history.createGame('lhCoachG', roster, {}));
    const firstDraftId = created.selectedDraftId;
    await history.withLineupLock('lhCoachG', () => history.finalizeGame('lhCoachG', created.gameId));
    await history.withLineupLock('lhCoachG', () => history.addAlternative('lhCoachG', created.gameId, {}));
    const afterAlt = history.getGame('lhCoachG', created.gameId);
    const secondDraftId = afterAlt.selectedDraftId;
    assert.notStrictEqual(secondDraftId, firstDraftId);

    const { game: refinalized } = await history.withLineupLock('lhCoachG', () => history.finalizeGame('lhCoachG', created.gameId));
    assert.strictEqual(refinalized.selectedDraftId, secondDraftId);
    assert.strictEqual(refinalized.status, 'finalized');
    const listed = history.listGames('lhCoachG');
    assert.strictEqual(listed.filter((g) => g.gameId === created.gameId).length, 1, 'must remain exactly one game record, never a second one');
  });

  await t.test('unfinalizeGame is idempotent on an already-draft game', async () => {
    const { roster } = seedRoster('lhCoachH');
    const created = await history.withLineupLock('lhCoachH', () => history.createGame('lhCoachH', roster, {}));
    const { alreadyDraft } = await history.withLineupLock('lhCoachH', () => history.unfinalizeGame('lhCoachH', created.gameId));
    assert.strictEqual(alreadyDraft, true);
  });

  await t.test('undoing finalization removes the game from future rotation stats', async () => {
    const { roster } = seedRoster('lhCoachI');
    const created = await history.withLineupLock('lhCoachI', () => history.createGame('lhCoachI', roster, { date: '2024-09-05' }));
    await history.withLineupLock('lhCoachI', () => history.finalizeGame('lhCoachI', created.gameId));
    const gamesAfterFinalize = Object.values(history.loadGames('lhCoachI').games);
    const statsFinalized = rotationStatsLib.buildRotationStats(gamesAfterFinalize);
    assert.strictEqual(statsFinalized.gamesConsidered, 1);

    await history.withLineupLock('lhCoachI', () => history.unfinalizeGame('lhCoachI', created.gameId));
    const gamesAfterUndo = Object.values(history.loadGames('lhCoachI').games);
    const statsUndone = rotationStatsLib.buildRotationStats(gamesAfterUndo);
    assert.strictEqual(statsUndone.gamesConsidered, 0, 'an unfinalized game must stop contributing to rotation history');
  });

  await t.test('drafts (never finalized), including repeated "generate another option" calls, never influence rotation stats', async () => {
    const { roster } = seedRoster('lhCoachJ');
    const created = await history.withLineupLock('lhCoachJ', () => history.createGame('lhCoachJ', roster, {}));
    for (let i = 0; i < 3; i++) {
      await history.withLineupLock('lhCoachJ', () => history.addAlternative('lhCoachJ', created.gameId, {}));
    }
    const games = Object.values(history.loadGames('lhCoachJ').games);
    const stats = rotationStatsLib.buildRotationStats(games);
    assert.strictEqual(stats.gamesConsidered, 0, 'a game that was never finalized must never count, no matter how many drafts it accumulated');
  });

  await t.test('addAlternative retries at most MAX_ALTERNATIVE_ATTEMPTS times and reports distinctFromPrevious: false when every slot is pinned (no possible alternative)', async () => {
    const { roster, players } = seedRoster('lhCoachK');
    const POSITIONS = ['goalkeeper', 'left_back', 'right_back', 'left_wing', 'center_mid', 'right_wing', 'striker'];
    const pinned = { 1: {}, 2: {}, 3: {}, 4: {} };
    for (const q of [1, 2, 3, 4]) {
      POSITIONS.forEach((pos, i) => {
        pinned[q][players[i].id] = pos;
      });
    }
    const created = await history.withLineupLock('lhCoachK', () => history.createGame('lhCoachK', roster, { pinned }));

    const original = scheduling.computeGameLineup;
    let calls = 0;
    scheduling.computeGameLineup = (...args) => {
      calls += 1;
      return original(...args);
    };
    let distinctFromPrevious;
    try {
      ({ distinctFromPrevious } = await history.withLineupLock('lhCoachK', () => history.addAlternative('lhCoachK', created.gameId, {})));
    } finally {
      scheduling.computeGameLineup = original;
    }
    assert.strictEqual(distinctFromPrevious, false);
    assert.strictEqual(calls, history.MAX_ALTERNATIVE_ATTEMPTS, `expected exactly the bounded retry count of attempts, got ${calls}`);
  });

  await t.test('refreshGame creates a brand-new game from the live roster and leaves the stale game record untouched', async () => {
    const { roster, players } = seedRoster('lhCoachL');
    const created = await history.withLineupLock('lhCoachL', () => history.createGame('lhCoachL', roster, { date: '2024-09-10' }));
    const staleSnapshotJson = JSON.stringify(created.frozenInputs);

    const live = soccerLineup.loadRoster('lhCoachL');
    soccerLineup.updatePlayerDirect(live, players[0].id, { goalie: 3 });
    soccerLineup.saveRoster('lhCoachL', live);

    const { game: refreshed, refreshedFromGameId } = await history.withLineupLock('lhCoachL', () =>
      history.refreshGame('lhCoachL', created.gameId, live, {})
    );
    assert.strictEqual(refreshedFromGameId, created.gameId);
    assert.notStrictEqual(refreshed.gameId, created.gameId);
    assert.strictEqual(refreshed.date, '2024-09-10', 'date carries over unless overridden');

    const staleAfter = history.getGame('lhCoachL', created.gameId);
    assert.strictEqual(JSON.stringify(staleAfter.frozenInputs), staleSnapshotJson, 'the original game record must be completely untouched by refreshGame');
  });

  await t.test('a formation change on the live roster never affects an already-created game\'s frozen formation', async () => {
    const { roster } = seedRoster('lhCoachM', '2-3-1');
    const created = await history.withLineupLock('lhCoachM', () => history.createGame('lhCoachM', roster, {}));
    assert.strictEqual(created.frozenInputs.formation, '2-3-1');

    const live = soccerLineup.loadRoster('lhCoachM');
    live.formation = '3-2-1';
    soccerLineup.saveRoster('lhCoachM', live);

    const { game: afterAlt } = await history.withLineupLock('lhCoachM', () => history.addAlternative('lhCoachM', created.gameId, {}));
    assert.strictEqual(afterAlt.frozenInputs.formation, '2-3-1', 'addAlternative must keep scheduling against the frozen formation');
    assert.strictEqual(afterAlt.drafts[afterAlt.selectedDraftId].result.formation, '2-3-1');
  });

  await t.test('a player removed from the roster after a game was saved still hydrates safely, keeping their name from the frozen snapshot', async () => {
    const { roster, players } = seedRoster('lhCoachN');
    const created = await history.withLineupLock('lhCoachN', () => history.createGame('lhCoachN', roster, {}));
    const live = soccerLineup.loadRoster('lhCoachN');
    soccerLineup.removePlayerDirect(live, players[0].id);
    soccerLineup.saveRoster('lhCoachN', live);

    // Must not throw, and the removed player's own frozen snapshot entry
    // (captured when this game was first created) is what supplies their
    // name for display — a historical game never needs the roster to still
    // contain someone who played in it.
    const reopened = history.getGame('lhCoachN', created.gameId, live);
    const draft = reopened.drafts[reopened.selectedDraftId];
    const stillReferenced =
      draft.result.quarters.some((q) => q.lineup.some((s) => s.player && s.player.id === players[0].id)) ||
      draft.result.quartersPlayedSummary.some((e) => e.id === players[0].id);
    assert.ok(stillReferenced, 'the removed player should still appear somewhere in this stored game');
    const summaryEntry = draft.result.quartersPlayedSummary.find((e) => e.id === players[0].id);
    assert.strictEqual(summaryEntry.name, players[0].name, 'the frozen snapshot preserves the real name even after removal');
  });

  await t.test('an id that truly has no snapshot entry anywhere (corrupted/orphaned reference) falls back to a safe placeholder instead of crashing', async () => {
    const { roster } = seedRoster('lhCoachOrphan');
    const created = await history.withLineupLock('lhCoachOrphan', () => history.createGame('lhCoachOrphan', roster, {}));
    const data = history.loadGames('lhCoachOrphan');
    const game = data.games[created.gameId];
    const draft = game.drafts[game.selectedDraftId];
    draft.result.quartersPlayedSummary.push({ id: 'ghost-player-id', quartersPlayed: 0 });
    history.saveGames('lhCoachOrphan', data);

    const reopened = history.getGame('lhCoachOrphan', created.gameId);
    const ghostEntry = reopened.drafts[reopened.selectedDraftId].result.quartersPlayedSummary.find((e) => e.id === 'ghost-player-id');
    assert.strictEqual(ghostEntry.name, '(removed player)');
  });

  await t.test('account isolation: two usernames\' games and rotation stats never mix', async () => {
    const { roster: rosterX } = seedRoster('lhCoachIsoX');
    const { roster: rosterY } = seedRoster('lhCoachIsoY');
    const gameX = await history.withLineupLock('lhCoachIsoX', () => history.createGame('lhCoachIsoX', rosterX, {}));
    await history.withLineupLock('lhCoachIsoX', () => history.finalizeGame('lhCoachIsoX', gameX.gameId));
    await history.withLineupLock('lhCoachIsoY', () => history.createGame('lhCoachIsoY', rosterY, {}));

    const listX = history.listGames('lhCoachIsoX');
    const listY = history.listGames('lhCoachIsoY');
    assert.ok(!listY.some((g) => g.gameId === gameX.gameId));
    assert.strictEqual(listX.length, 1);
    assert.strictEqual(listY.length, 1);

    const statsY = rotationStatsLib.buildRotationStats(Object.values(history.loadGames('lhCoachIsoY').games));
    assert.strictEqual(statsY.gamesConsidered, 0, 'account Y must never see account X\'s finalized game in its own rotation stats');
  });

  await t.test('a corrupt games file is surfaced as an error, never silently treated as empty history', async () => {
    const { roster } = seedRoster('lhCoachCorrupt');
    await history.withLineupLock('lhCoachCorrupt', () => history.createGame('lhCoachCorrupt', roster, {}));
    const filePath = path.join(history.getLineupDir(), 'lhCoachCorrupt.json');
    fs.writeFileSync(filePath, '{not valid json');
    assert.throws(() => history.loadGames('lhCoachCorrupt'), history.LineupHistoryError);
  });

  await t.test('a nonexistent gameId is reported as GAME_NOT_FOUND, not a crash', () => {
    assert.throws(
      () => history.getGame('lhCoachA', 'no-such-game-id'),
      (err) => err instanceof history.LineupHistoryError && err.code === 'GAME_NOT_FOUND'
    );
  });

  await t.test('concurrent finalization under the same lock never corrupts the file or double-applies', async () => {
    const { roster } = seedRoster('lhCoachConcurrent');
    const created = await history.withLineupLock('lhCoachConcurrent', () => history.createGame('lhCoachConcurrent', roster, {}));
    const results = await Promise.all(
      Array.from({ length: 5 }, () => history.withLineupLock('lhCoachConcurrent', () => history.finalizeGame('lhCoachConcurrent', created.gameId)))
    );
    assert.strictEqual(results.filter((r) => r.alreadyFinalized === false).length, 1, 'exactly one of the concurrent calls should be the actual transition');
    assert.strictEqual(results.filter((r) => r.alreadyFinalized === true).length, 4);
    const finalRead = history.getGame('lhCoachConcurrent', created.gameId);
    assert.strictEqual(finalRead.status, 'finalized');
  });

  await t.test('five concurrent createGame calls under the same lock all persist as five distinct games', async () => {
    const { roster } = seedRoster('lhCoachConcurrentCreate');
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        history.withLineupLock('lhCoachConcurrentCreate', () => history.createGame('lhCoachConcurrentCreate', roster, { date: `2024-10-0${i + 1}` }))
      )
    );
    const ids = new Set(results.map((g) => g.gameId));
    assert.strictEqual(ids.size, 5);
    assert.strictEqual(history.listGames('lhCoachConcurrentCreate').length, 5);
  });

  t.after(() => {
    fs.rmSync(process.env.RAYGPT_DATA_DIR, { recursive: true, force: true });
  });
});
