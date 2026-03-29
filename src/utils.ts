/**
 * Seeded PRNG and weighted random selection utilities.
 *
 * @module utils
 * @license MIT
 * @copyright 2016 Maxim Gumin
 */

/**
 * Fast seeded pseudo-random number generator using the xoshiro128** algorithm.
 *
 * Produces deterministic sequences from a given seed, making WFC results
 * reproducible. State is initialized via SplitMix32 expansion of a single
 * 32-bit seed.
 *
 * @example
 * ```ts
 * const rng = new Random(42);
 * const value = rng.nextDouble(); // float in [0, 1)
 * ```
 */
export class Random {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(seed: number) {
    // SplitMix32 to initialize 4 × 32-bit state from a single seed.
    let s = seed | 0;
    const splitmix32 = (): number => {
      s = (s + 0x9e3779b9) | 0;
      let t = s ^ (s >>> 16);
      t = Math.imul(t, 0x21f0aaad);
      t = t ^ (t >>> 15);
      t = Math.imul(t, 0x735a2d97);
      t = t ^ (t >>> 15);
      return t >>> 0;
    };
    this.s0 = splitmix32();
    this.s1 = splitmix32();
    this.s2 = splitmix32();
    this.s3 = splitmix32();
  }

  /** Returns a uniformly distributed random float in [0, 1). */
  nextDouble(): number {
    return (this.next() >>> 0) / 4294967296;
  }

  /**
   * Advance the xoshiro128** state and return the next 32-bit value.
   *
   * IMPORTANT: The XOR chain is order-dependent — each step must read the
   * result of the previous mutation. Using `let` with sequential `^=`
   * ensures correctness (the original code used `const` copies which broke
   * the dependency chain).
   */
  private next(): number {
    let s0 = this.s0;
    let s1 = this.s1;
    let s2 = this.s2;
    let s3 = this.s3;

    const result = Math.imul(rotl(Math.imul(s1, 5), 7), 9);
    const t = s1 << 9;

    s2 ^= s0;
    s3 ^= s1;
    s1 ^= s2;
    s0 ^= s3;
    s2 ^= t;
    s3 = rotl(s3, 11);

    this.s0 = s0;
    this.s1 = s1;
    this.s2 = s2;
    this.s3 = s3;

    return result;
  }
}

function rotl(x: number, k: number): number {
  return (x << k) | (x >>> (32 - k));
}

/**
 * Select a random index from a weighted distribution.
 *
 * @param weights - Array of non-negative weights (zero = excluded).
 * @param r - Uniform random value in [0, 1).
 * @returns The selected index, or 0 if all weights are zero.
 */
export function weightedRandom(weights: Float64Array, r: number): number {
  let sum = 0;
  for (let i = 0; i < weights.length; i++) sum += weights[i];

  const threshold = r * sum;
  let partialSum = 0;
  for (let i = 0; i < weights.length; i++) {
    partialSum += weights[i];
    if (partialSum >= threshold) return i;
  }
  return 0;
}
