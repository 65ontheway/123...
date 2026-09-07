const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

process.env.RAYGPT_DATA_DIR = path.join(os.tmpdir(), 'raygpt-test-soccerPrivacy-' + process.pid);

const soccerLineup = require('../lib/soccerLineup');
const soccerPrivacy = require('../lib/soccerPrivacy');

function buildFixtureRoster() {
  const roster = { formation: '2-3-1', players: [] };
  const alpha = soccerLineup.addPlayerDirect(roster, { name: 'Fixture Alpha', offense: 4, defense: 2, goalie: 1 });
  const bravo = soccerLineup.addPlayerDirect(roster, { name: 'Fixture Bravo', offense: 3, defense: 3, goalie: 3 });
  const sam1 = soccerLineup.addPlayerDirect(roster, { name: 'Fixture Sam' });
  const sam2 = soccerLineup.addPlayerDirect(roster, { name: 'Fixture Sam' });
  return { roster, alpha, bravo, sam1, sam2 };
}

test('soccerPrivacy.js', async (t) => {
  await t.test('scrubText replaces an unambiguous roster name with its label, nothing else', () => {
    const { roster, alpha, bravo } = buildFixtureRoster();
    const ctx = soccerPrivacy.buildAnonymizationContext(roster);
    const result = soccerPrivacy.scrubText('Rest Fixture Alpha this quarter, and pin Fixture Bravo to forward.', ctx);
    assert.ok(!result.text.includes('Fixture Alpha'));
    assert.ok(!result.text.includes('Fixture Bravo'));
    assert.ok(result.text.includes(ctx.labelByPlayerId.get(alpha.id)));
    assert.ok(result.text.includes(ctx.labelByPlayerId.get(bravo.id)));
    assert.strictEqual(result.ambiguousNames.size, 0);
  });

  await t.test('scrubText never matches a name as a substring of an unrelated word', () => {
    const roster = { formation: '2-3-1', players: [] };
    soccerLineup.addPlayerDirect(roster, { name: 'Sam' });
    const ctx = soccerPrivacy.buildAnonymizationContext(roster);
    const result = soccerPrivacy.scrubText('I bought a Samsung phone for Sam.', ctx);
    assert.ok(result.text.includes('Samsung'), 'unrelated word containing the name as a substring must survive: ' + result.text);
    assert.ok(!/\bSam\b/.test(result.text), 'the real standalone name must be scrubbed: ' + result.text);
  });

  await t.test('scrubText flags a name shared by two players as ambiguous and leaves it untouched', () => {
    const { roster } = buildFixtureRoster();
    const ctx = soccerPrivacy.buildAnonymizationContext(roster);
    const result = soccerPrivacy.scrubText('Rest Fixture Sam this quarter.', ctx);
    assert.ok(result.ambiguousNames.has('Fixture Sam'));
    assert.ok(result.text.includes('Fixture Sam'), 'an ambiguous name must not be guessed at');
  });

  await t.test('scrubMessages scrubs every message in a list, including replayed history, not just the latest', () => {
    const { roster, bravo } = buildFixtureRoster();
    const ctx = soccerPrivacy.buildAnonymizationContext(roster);
    const messages = [
      { role: 'user', content: 'Hows Fixture Bravo doing?' },
      { role: 'assistant', content: 'Fixture Bravo has solid ratings.' },
      { role: 'user', content: 'Great, thanks!' },
    ];
    const { messages: scrubbed, ambiguousNames } = soccerPrivacy.scrubMessages(messages, ctx);
    assert.strictEqual(ambiguousNames.size, 0);
    const joined = JSON.stringify(scrubbed);
    assert.ok(!joined.includes('Fixture Bravo'), 'no message, including history, may still contain the real name');
    assert.ok(joined.includes(ctx.labelByPlayerId.get(bravo.id)));
  });

  await t.test('an image/file attachment is detected and stripped, replaced with a neutral note', () => {
    const content = [
      { type: 'text', text: 'hello' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,x' } },
    ];
    assert.strictEqual(soccerPrivacy.hasUnsupportedAttachment(content), true);
    assert.strictEqual(soccerPrivacy.hasUnsupportedAttachment('plain text'), false);
    assert.strictEqual(soccerPrivacy.hasUnsupportedAttachment([{ type: 'text', text: 'hi' }]), false);
    const extracted = soccerPrivacy.extractTextOnly(content);
    assert.ok(extracted.hadAttachment);
    assert.ok(extracted.text.includes('attachment omitted'));
  });

  await t.test('looksLikeAddRequest catches common enrollment phrasing, not ordinary scheduling requests', () => {
    assert.ok(soccerPrivacy.looksLikeAddRequest('add Fixture Charlie to the team'));
    assert.ok(soccerPrivacy.looksLikeAddRequest('please sign up a new player'));
    assert.ok(!soccerPrivacy.looksLikeAddRequest('rest Fixture Alpha this quarter'));
    assert.ok(!soccerPrivacy.looksLikeAddRequest('bump Fixture Bravo defense to 4'));
  });

  await t.test('describeRosterAnonymized never contains a real name', () => {
    const { roster } = buildFixtureRoster();
    const ctx = soccerPrivacy.buildAnonymizationContext(roster);
    const desc = soccerPrivacy.describeRosterAnonymized(roster, ctx);
    assert.ok(!desc.includes('Fixture'));
  });

  await t.test('applyChatRosterEdits updates ratings without ever renaming the player to their own label', () => {
    const { roster, alpha } = buildFixtureRoster();
    const ctx = soccerPrivacy.buildAnonymizationContext(roster);
    const label = ctx.labelByPlayerId.get(alpha.id);
    const msg = soccerPrivacy.applyChatRosterEdits(roster, { update: [{ name: label, offense: 5 }] }, ctx);
    assert.ok(!msg.includes('Fixture'), 'confirmation message must never contain a real name: ' + msg);
    const updated = soccerLineup.findPlayerById(roster.players, alpha.id);
    assert.strictEqual(updated.skills.offense, 5, 'the rating must actually update');
    assert.strictEqual(updated.name, 'Fixture Alpha', 'the real name must NOT be overwritten with the label');
  });

  await t.test('applyChatRosterEdits removes by label, never contains a real name in its message', () => {
    const { roster, bravo } = buildFixtureRoster();
    const ctx = soccerPrivacy.buildAnonymizationContext(roster);
    const label = ctx.labelByPlayerId.get(bravo.id);
    const msg = soccerPrivacy.applyChatRosterEdits(roster, { remove: [label] }, ctx);
    assert.ok(!msg.includes('Fixture'));
    assert.strictEqual(soccerLineup.findPlayerById(roster.players, bravo.id), null);
  });

  await t.test('translateSchedulingArgsToIds + formatGameLineupResultAnonymized never leak a real name', () => {
    const { roster, sam1 } = buildFixtureRoster();
    for (let i = 0; i < 4; i++) soccerLineup.addPlayerDirect(roster, { name: `Fixture Filler ${i}` });
    const ctx = soccerPrivacy.buildAnonymizationContext(roster);
    const label = ctx.labelByPlayerId.get(sam1.id);
    const translated = soccerPrivacy.translateSchedulingArgsToIds({ resting: { 1: [label] } }, ctx);
    assert.strictEqual(translated.resting['1'][0], sam1.id);
    const result = soccerLineup.computeGameLineup(roster, translated);
    const output = soccerPrivacy.formatGameLineupResultAnonymized(result, ctx);
    assert.ok(!output.includes('Fixture'), 'anonymized lineup output must never contain a real name: ' + output);
  });

  await t.test('deanonymize turns the model\'s label-only text back into real names', () => {
    const { roster, alpha, sam1 } = buildFixtureRoster();
    const ctx = soccerPrivacy.buildAnonymizationContext(roster);
    const labelA = ctx.labelByPlayerId.get(alpha.id);
    const labelS = ctx.labelByPlayerId.get(sam1.id);
    const modelText = `${labelA} will rest in Q1, and ${labelS} plays forward.`;
    const result = soccerPrivacy.deanonymize(modelText, ctx);
    assert.ok(result.includes('Fixture Alpha'));
    assert.ok(result.includes('Fixture Sam'));
  });

  await t.test('deanonymize leaves an unrecognized label untouched rather than guessing', () => {
    const { roster } = buildFixtureRoster();
    const ctx = soccerPrivacy.buildAnonymizationContext(roster);
    const result = soccerPrivacy.deanonymize('Player_999 is not real.', ctx);
    assert.strictEqual(result, 'Player_999 is not real.');
  });
});
