'use strict';
/**
 * Deterministic pseudo-random number generation.
 *
 * Every source of randomness in the simulation comes from here, keyed by an
 * explicit seed. Two runs with the same seed and the same sequence of actions
 * produce byte-identical state, which is what makes the baseline comparison
 * meaningful and lets tests assert reproducibility.
 *
 * Streams are independent: consuming an extra market draw (say, one more
 * supplier quote) never shifts the demand sequence. That matters because the
 * AI company issues a different number of reads than the baseline.
 */

function hashSeed(input) {
  const str = String(input);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32: small, fast, good enough for simulation, fully deterministic. */
function mulberry32(seedInt) {
  let a = seedInt >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Stream {
  constructor(name, seed) {
    this.name = name;
    this._next = mulberry32(hashSeed(`${seed}::${name}`));
    this.draws = 0;
  }

  float() {
    this.draws += 1;
    return this._next();
  }

  /** Uniform float in [min, max). */
  range(min, max) {
    return min + (max - min) * this.float();
  }

  /** Integer in [min, max] inclusive. */
  int(min, max) {
    return Math.floor(this.range(min, max + 1));
  }

  bool(p = 0.5) {
    return this.float() < p;
  }

  pick(items) {
    if (!items.length) return undefined;
    return items[this.int(0, items.length - 1)];
  }

  /** Box-Muller normal, mean 0 sd 1. */
  normal() {
    const u1 = Math.max(this.float(), 1e-12);
    const u2 = this.float();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  /** Normal clamped to +/- 3 sd. */
  normalClamped(mean = 0, sd = 1) {
    const z = Math.max(-3, Math.min(3, this.normal()));
    return mean + z * sd;
  }

  shuffle(items) {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = this.int(0, i);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
}

/** Named, independent random streams for one simulation seed. */
function makeStreams(seed, names = ['market', 'demand', 'supplier', 'ops', 'events', 'pricing']) {
  const streams = {};
  for (const name of names) streams[name] = new Stream(name, seed);
  return streams;
}

module.exports = { hashSeed, mulberry32, Stream, makeStreams };
