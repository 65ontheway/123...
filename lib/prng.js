// A small, dependency-free seeded pseudorandom generator, used only by the
// Soccer Lineup scheduler's rotation/variety feature (see soccerScheduling.js
// and soccerRotationStats.js). Deliberately NOT cryptographic — this exists
// purely so "the same inputs + the same seed always produce the same
// lineup" while different seeds produce different-but-still-valid ones.
// Nothing in this file ever calls Math.random(); every call site that wants
// variety must go through an explicit seed.

// FNV-1a: turns an arbitrary string seed into a 32-bit unsigned integer,
// so callers can seed with something readable (a draft id, "gameId:seed
// number") rather than being forced to hand-pick a raw 32-bit value.
function hashStringToUint32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// mulberry32: a fast, simple, well-distributed 32-bit generator. Good
// enough for "pick a plausible-looking alternative lineup" — this is not
// security-sensitive randomness.
function mulberry32(seedUint32) {
  let a = seedUint32 >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Accepts either a string (hashed via FNV-1a) or a finite number (used
// directly, coerced to a uint32) as the seed. Returns a `next()` function
// yielding floats in [0, 1) — same contract as Math.random(), but
// reproducible for a given seed.
function createRng(seed) {
  const seedUint32 = typeof seed === 'number' && Number.isFinite(seed) ? seed >>> 0 : hashStringToUint32(String(seed ?? ''));
  return mulberry32(seedUint32);
}

// Picks one item from `items` using per-item non-negative `weights`
// (parallel array, same length) and a `rng()` in [0, 1). Falls back to a
// uniform pick if every weight is zero (never divides by zero / stalls).
// Deterministic for a given rng state — callers control reproducibility by
// controlling the rng.
function weightedPick(items, weights, rng) {
  if (items.length === 0) return undefined;
  if (items.length === 1) return items[0];
  const total = weights.reduce((sum, w) => sum + Math.max(0, w), 0);
  if (total <= 0) {
    return items[Math.floor(rng() * items.length) % items.length];
  }
  let target = rng() * total;
  for (let i = 0; i < items.length; i++) {
    target -= Math.max(0, weights[i]);
    if (target <= 0) return items[i];
  }
  return items[items.length - 1]; // floating-point fallback
}

module.exports = { hashStringToUint32, createRng, weightedPick };
