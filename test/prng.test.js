const test = require('node:test');
const assert = require('node:assert/strict');
const { hashStringToUint32, createRng, weightedPick } = require('../lib/prng');

test('prng.js', async (t) => {
  await t.test('hashStringToUint32 is deterministic for the same string', () => {
    assert.strictEqual(hashStringToUint32('draft-abc-1'), hashStringToUint32('draft-abc-1'));
  });

  await t.test('hashStringToUint32 differs for different strings (no trivial collision)', () => {
    assert.notStrictEqual(hashStringToUint32('seed-a'), hashStringToUint32('seed-b'));
  });

  await t.test('createRng with the same seed produces the identical sequence', () => {
    const a = createRng('same-seed');
    const b = createRng('same-seed');
    const seqA = Array.from({ length: 20 }, () => a());
    const seqB = Array.from({ length: 20 }, () => b());
    assert.deepStrictEqual(seqA, seqB);
  });

  await t.test('createRng with a numeric seed is deterministic too', () => {
    const a = createRng(12345);
    const b = createRng(12345);
    assert.strictEqual(a(), b());
    assert.strictEqual(a(), b());
  });

  await t.test('createRng with different seeds produces different sequences', () => {
    const a = createRng('seed-one');
    const b = createRng('seed-two');
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    assert.notDeepStrictEqual(seqA, seqB);
  });

  await t.test('createRng always yields floats in [0, 1)', () => {
    const rng = createRng('range-check');
    for (let i = 0; i < 500; i++) {
      const v = rng();
      assert.ok(v >= 0 && v < 1, `value ${v} out of [0,1)`);
    }
  });

  await t.test('weightedPick: empty items returns undefined', () => {
    assert.strictEqual(weightedPick([], [], createRng('x')), undefined);
  });

  await t.test('weightedPick: a single item is always returned without consuming rng', () => {
    let calls = 0;
    const rng = () => {
      calls += 1;
      return 0.5;
    };
    assert.strictEqual(weightedPick(['only'], [3], rng), 'only');
    assert.strictEqual(calls, 0, 'a single candidate should short-circuit before touching rng');
  });

  await t.test('weightedPick: all-zero weights falls back to a uniform, still-deterministic pick', () => {
    const rng = createRng('zero-weights');
    const items = ['a', 'b', 'c'];
    const picked = weightedPick(items, [0, 0, 0], rng);
    assert.ok(items.includes(picked));
    // Same seed, same fallback path -> same result.
    const picked2 = weightedPick(items, [0, 0, 0], createRng('zero-weights'));
    assert.strictEqual(picked, picked2);
  });

  await t.test('weightedPick: an overwhelmingly heavier weight wins the large majority of draws', () => {
    const items = ['light', 'heavy'];
    const weights = [1, 99];
    const counts = { light: 0, heavy: 0 };
    const rng = createRng('distribution-check');
    for (let i = 0; i < 1000; i++) {
      counts[weightedPick(items, weights, rng)] += 1;
    }
    assert.ok(counts.heavy > counts.light * 5, `expected heavy >> light, got ${JSON.stringify(counts)}`);
  });

  await t.test('weightedPick is a pure function of (items, weights, rng state) — reproducible end to end', () => {
    const items = ['p1', 'p2', 'p3'];
    const weights = [2, 1, 1];
    const runOnce = (seed) => {
      const rng = createRng(seed);
      return Array.from({ length: 15 }, () => weightedPick(items, weights, rng));
    };
    assert.deepStrictEqual(runOnce('repro-seed'), runOnce('repro-seed'));
  });
});
