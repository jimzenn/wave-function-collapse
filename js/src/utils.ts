// Copyright (C) 2016 Maxim Gumin, The MIT License (MIT)

/**
 * Fast seeded PRNG (xoshiro128**).
 * Much faster than Math.random() and reproducible from seed.
 */
export class Random {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(seed: number) {
    // SplitMix32 to initialize state from a single seed
    seed = seed | 0;
    let s = seed;
    const sm = () => {
      s = (s + 0x9e3779b9) | 0;
      let t = s ^ (s >>> 16);
      t = Math.imul(t, 0x21f0aaad);
      t = t ^ (t >>> 15);
      t = Math.imul(t, 0x735a2d97);
      t = t ^ (t >>> 15);
      return t >>> 0;
    };
    this.s0 = sm();
    this.s1 = sm();
    this.s2 = sm();
    this.s3 = sm();
  }

  /** Returns a random float in [0, 1). */
  nextDouble(): number {
    const result = this.next() >>> 0;
    return result / 4294967296;
  }

  private next(): number {
    const s0 = this.s0;
    const s1 = this.s1;
    const s2 = this.s2;
    const s3 = this.s3;

    const result = Math.imul(rotl(Math.imul(s1, 5), 7), 9);
    const t = s1 << 9;

    this.s2 = s2 ^ s0;
    this.s3 = s3 ^ s1;
    this.s1 = s1 ^ s2;
    this.s0 = s0 ^ s3;
    this.s2 = s2 ^ t;
    this.s3 = rotl(s3, 11);

    return result;
  }
}

function rotl(x: number, k: number): number {
  return (x << k) | (x >>> (32 - k));
}

/**
 * Weighted random selection from a distribution array.
 * Returns the index selected.
 */
export function weightedRandom(
  weights: Float64Array,
  r: number,
  length: number
): number {
  let sum = 0;
  for (let i = 0; i < length; i++) sum += weights[i];
  let threshold = r * sum;
  let partialSum = 0;
  for (let i = 0; i < length; i++) {
    partialSum += weights[i];
    if (partialSum >= threshold) return i;
  }
  return 0;
}
