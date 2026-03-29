// Copyright (C) 2016 Maxim Gumin, The MIT License (MIT)
// TypeScript port — performance-optimized with TypedArrays

import { Heuristic, type WFCResult } from "./types.js";
import { Random, weightedRandom } from "./utils.js";

/**
 * Abstract base class implementing the core WFC observe/propagate loop.
 *
 * Performance notes:
 * - `wave` is a flat Uint8Array (MX*MY*T), accessed as wave[i*T + t].
 * - `compatible` is a flat Int32Array (MX*MY*T*4), accessed as compatible[(i*T + t)*4 + d].
 * - `stack` is a flat Int32Array storing (cellIndex, patternIndex) pairs.
 * - All per-cell accumulators use Float64Arrays for entropy precision.
 */
export abstract class Model {
  // Dimensions
  readonly MX: number;
  readonly MY: number;
  readonly N: number;
  readonly periodic: boolean;

  // Pattern count — set by subclass constructor
  protected T: number = 0;
  protected ground: boolean = false;

  // Weights — set by subclass
  protected weights!: Float64Array;

  // Propagator: propagator[d][t] = Int32Array of compatible pattern indices
  protected propagator!: Int32Array[][];

  // Wave state: flat MX*MY*T (1 = possible, 0 = banned)
  private wave!: Uint8Array;

  // Compatible counts: flat (MX*MY*T*4)
  private compatible!: Int32Array;

  // Observation result
  protected observed!: Int32Array;

  // Propagation stack: pairs of (cellIndex, patternIndex)
  private stack!: Int32Array;
  private stackSize: number = 0;
  private observedSoFar: number = 0;

  // Cached weight data
  private weightLogWeights!: Float64Array;
  private distribution!: Float64Array;

  // Per-cell accumulators
  protected sumsOfOnes!: Int32Array;
  private sumsOfWeights!: Float64Array;
  private sumsOfWeightLogWeights!: Float64Array;
  private entropies!: Float64Array;

  // Global sums
  private sumOfWeights: number = 0;
  private sumOfWeightLogWeights: number = 0;
  private startingEntropy: number = 0;

  private heuristic: Heuristic;
  private initialized: boolean = false;

  protected constructor(
    width: number,
    height: number,
    N: number,
    periodic: boolean,
    heuristic: Heuristic
  ) {
    this.MX = width;
    this.MY = height;
    this.N = N;
    this.periodic = periodic;
    this.heuristic = heuristic;
  }

  private init(): void {
    const waveLen = this.MX * this.MY;
    const T = this.T;

    this.wave = new Uint8Array(waveLen * T);
    this.compatible = new Int32Array(waveLen * T * 4);
    this.distribution = new Float64Array(T);
    this.observed = new Int32Array(waveLen);

    this.weightLogWeights = new Float64Array(T);
    this.sumOfWeights = 0;
    this.sumOfWeightLogWeights = 0;

    for (let t = 0; t < T; t++) {
      const w = this.weights[t];
      this.weightLogWeights[t] = w * Math.log(w);
      this.sumOfWeights += w;
      this.sumOfWeightLogWeights += this.weightLogWeights[t];
    }

    this.startingEntropy =
      Math.log(this.sumOfWeights) -
      this.sumOfWeightLogWeights / this.sumOfWeights;

    this.sumsOfOnes = new Int32Array(waveLen);
    this.sumsOfWeights = new Float64Array(waveLen);
    this.sumsOfWeightLogWeights = new Float64Array(waveLen);
    this.entropies = new Float64Array(waveLen);

    this.stack = new Int32Array(waveLen * T * 2);
    this.stackSize = 0;
    this.initialized = true;
  }

  /**
   * Run the WFC algorithm.
   * @param seed - Random seed for reproducibility.
   * @param limit - Maximum iterations (-1 for unlimited).
   * @returns Result object with success flag and observed array.
   */
  run(seed: number, limit: number = -1): WFCResult {
    if (!this.initialized) this.init();

    this.clear();
    const random = new Random(seed);

    for (let l = 0; l < limit || limit < 0; l++) {
      const node = this.nextUnobservedNode(random);
      if (node >= 0) {
        this.observe(node, random);
        const success = this.propagate();
        if (!success) {
          return { success: false, observed: this.observed };
        }
      } else {
        // All cells observed — finalize
        const T = this.T;
        const wave = this.wave;
        const waveLen = this.MX * this.MY;
        for (let i = 0; i < waveLen; i++) {
          const base = i * T;
          for (let t = 0; t < T; t++) {
            if (wave[base + t]) {
              this.observed[i] = t;
              break;
            }
          }
        }
        return { success: true, observed: this.observed };
      }
    }

    return { success: true, observed: this.observed };
  }

  private nextUnobservedNode(random: Random): number {
    const MX = this.MX;
    const MY = this.MY;
    const N = this.N;
    const periodic = this.periodic;
    const sumsOfOnes = this.sumsOfOnes;
    const waveLen = MX * MY;

    if (this.heuristic === Heuristic.Scanline) {
      for (let i = this.observedSoFar; i < waveLen; i++) {
        if (!periodic && (i % MX + N > MX || ((i / MX) | 0) + N > MY))
          continue;
        if (sumsOfOnes[i] > 1) {
          this.observedSoFar = i + 1;
          return i;
        }
      }
      return -1;
    }

    let min = 1e4;
    let argmin = -1;
    const entropies = this.entropies;
    const useEntropy = this.heuristic === Heuristic.Entropy;

    for (let i = 0; i < waveLen; i++) {
      if (!periodic && (i % MX + N > MX || ((i / MX) | 0) + N > MY))
        continue;
      const remaining = sumsOfOnes[i];
      if (remaining <= 1) continue;
      const entropy = useEntropy ? entropies[i] : remaining;
      if (entropy <= min) {
        const noise = 1e-6 * random.nextDouble();
        if (entropy + noise < min) {
          min = entropy + noise;
          argmin = i;
        }
      }
    }
    return argmin;
  }

  private observe(node: number, random: Random): void {
    const T = this.T;
    const wave = this.wave;
    const weights = this.weights;
    const distribution = this.distribution;
    const base = node * T;

    for (let t = 0; t < T; t++) {
      distribution[t] = wave[base + t] ? weights[t] : 0.0;
    }

    const r = weightedRandom(distribution, random.nextDouble(), T);

    for (let t = 0; t < T; t++) {
      if (wave[base + t] && t !== r) {
        this.ban(node, t);
      }
    }
  }

  private propagate(): boolean {
    const MX = this.MX;
    const MY = this.MY;
    const N = this.N;
    const periodic = this.periodic;
    const propagator = this.propagator;
    const compatible = this.compatible;
    const wave = this.wave;
    const T = this.T;
    const stack = this.stack;

    while (this.stackSize > 0) {
      this.stackSize--;
      const si = this.stackSize * 2;
      const i1 = stack[si];
      const t1 = stack[si + 1];

      const x1 = i1 % MX;
      const y1 = (i1 / MX) | 0;

      for (let d = 0; d < 4; d++) {
        let x2 = x1 + DX[d];
        let y2 = y1 + DY[d];

        if (
          !periodic &&
          (x2 < 0 || y2 < 0 || x2 + N > MX || y2 + N > MY)
        )
          continue;

        if (x2 < 0) x2 += MX;
        else if (x2 >= MX) x2 -= MX;
        if (y2 < 0) y2 += MY;
        else if (y2 >= MY) y2 -= MY;

        const i2 = x2 + y2 * MX;
        const p = propagator[d][t1];
        const pLen = p.length;
        const compatBase = i2 * T;

        for (let l = 0; l < pLen; l++) {
          const t2 = p[l];
          const compIdx = (compatBase + t2) * 4 + d;
          compatible[compIdx]--;
          if (compatible[compIdx] === 0) this.ban(i2, t2);
        }
      }
    }

    return this.sumsOfOnes[0] > 0;
  }

  private ban(i: number, t: number): void {
    const T = this.T;
    this.wave[i * T + t] = 0;

    const compBase = (i * T + t) * 4;
    const compatible = this.compatible;
    compatible[compBase] = 0;
    compatible[compBase + 1] = 0;
    compatible[compBase + 2] = 0;
    compatible[compBase + 3] = 0;

    const si = this.stackSize * 2;
    this.stack[si] = i;
    this.stack[si + 1] = t;
    this.stackSize++;

    this.sumsOfOnes[i]--;
    this.sumsOfWeights[i] -= this.weights[t];
    this.sumsOfWeightLogWeights[i] -= this.weightLogWeights[t];

    const sum = this.sumsOfWeights[i];
    this.entropies[i] =
      Math.log(sum) - this.sumsOfWeightLogWeights[i] / sum;
  }

  private clear(): void {
    const waveLen = this.MX * this.MY;
    const T = this.T;
    const wave = this.wave;
    const compatible = this.compatible;
    const propagator = this.propagator;
    const weights = this.weights;

    for (let i = 0; i < waveLen; i++) {
      const wBase = i * T;
      const cBase = i * T;
      for (let t = 0; t < T; t++) {
        wave[wBase + t] = 1;
        const compBase = (cBase + t) * 4;
        compatible[compBase + 0] = propagator[OPPOSITE[0]][t].length;
        compatible[compBase + 1] = propagator[OPPOSITE[1]][t].length;
        compatible[compBase + 2] = propagator[OPPOSITE[2]][t].length;
        compatible[compBase + 3] = propagator[OPPOSITE[3]][t].length;
      }

      this.sumsOfOnes[i] = T;
      this.sumsOfWeights[i] = this.sumOfWeights;
      this.sumsOfWeightLogWeights[i] = this.sumOfWeightLogWeights;
      this.entropies[i] = this.startingEntropy;
      this.observed[i] = -1;
    }
    this.observedSoFar = 0;

    // Pre-ban patterns that have no neighbors in any direction
    const MX = this.MX;
    const MY = this.MY;
    const N = this.N;
    const periodic = this.periodic;

    for (let y = 0; y < MY; y++) {
      for (let x = 0; x < MX; x++) {
        if (!periodic && (x + N > MX || y + N > MY)) continue;
        const i = x + y * MX;
        for (let t = 0; t < T; t++) {
          const noRight =
            (periodic || x < MX - N) && propagator[2][t].length === 0;
          const noTop =
            (periodic || y > 0) && propagator[3][t].length === 0;
          const noLeft =
            (periodic || x > 0) && propagator[0][t].length === 0;
          const noBottom =
            (periodic || y < MY - N) && propagator[1][t].length === 0;
          if (noRight || noTop || noLeft || noBottom) this.ban(i, t);
        }
      }
    }

    // Ground constraint
    if (this.ground) {
      for (let x = 0; x < MX; x++) {
        const bottom = x + (MY - 1) * MX;
        for (let t = 0; t < T - 1; t++) {
          if (wave[bottom * T + t]) this.ban(bottom, t);
        }
        for (let y = 0; y < MY - 1; y++) {
          const ii = x + y * MX;
          if (wave[ii * T + (T - 1)]) this.ban(ii, T - 1);
        }
      }
    }

    if (this.stackSize > 0) this.propagate();
  }

  /** Read the wave state for a cell. Returns which patterns are still possible. */
  getWave(cellIndex: number): Uint8Array {
    const base = cellIndex * this.T;
    return this.wave.subarray(base, base + this.T);
  }

  /** Get current sums-of-weights for rendering partial results. */
  getSumsOfWeights(): Float64Array {
    return this.sumsOfWeights;
  }
}

// Direction offsets: 0=left, 1=down, 2=right, 3=up
const DX = [-1, 0, 1, 0] as const;
const DY = [0, 1, 0, -1] as const;
const OPPOSITE = [2, 3, 0, 1] as const;
