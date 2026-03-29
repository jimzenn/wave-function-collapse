/**
 * Core WFC algorithm — abstract base class for both overlapping and tiled models.
 *
 * Implements the observe/propagate loop with flat TypedArray storage for
 * cache-friendly access and minimal GC pressure.
 *
 * @module model
 * @license MIT
 * @copyright 2016 Maxim Gumin
 */

import { Heuristic, type WFCResult } from "./types.js";
import { Random, weightedRandom } from "./utils.js";

/** Direction offsets: 0 = left, 1 = down, 2 = right, 3 = up. */
const DX = [-1, 0, 1, 0] as const;
const DY = [0, 1, 0, -1] as const;
const OPPOSITE = [2, 3, 0, 1] as const;

/**
 * Abstract base class implementing the Wave Function Collapse algorithm.
 *
 * Subclasses ({@link OverlappingModel}, {@link SimpleTiledModel}) are
 * responsible for building the `propagator` and `weights` arrays in their
 * constructors. The base class owns the core observe/propagate loop.
 *
 * ## Internal data layout (performance notes)
 *
 * | Array | Layout | Description |
 * |-------|--------|-------------|
 * | `wave` | `Uint8Array[MX*MY*T]` | 1 = pattern possible, 0 = banned |
 * | `compatible` | `Int32Array[MX*MY*T*4]` | per-direction compatible neighbor counts |
 * | `stack` | `Int32Array[MX*MY*T*2]` | propagation worklist (cell, pattern) pairs |
 */
export abstract class Model {
  /** Output grid width in cells. */
  readonly MX: number;
  /** Output grid height in cells. */
  readonly MY: number;
  /** Pattern size (NxN). Always 1 for SimpleTiledModel. */
  readonly N: number;
  /** Whether the output wraps at edges. */
  readonly periodic: boolean;

  /** Number of distinct patterns/tiles. Set by the subclass constructor. */
  protected T: number = 0;
  /** Whether the ground constraint is active. */
  protected ground: boolean = false;

  /** Per-pattern weights (frequency/probability). Set by the subclass. */
  protected weights!: Float64Array;

  /**
   * Propagator lookup: `propagator[direction][pattern]` yields an `Int32Array`
   * of pattern indices that are compatible in that direction. Set by the subclass.
   */
  protected propagator!: Int32Array[][];

  // --- Private hot-path state (flat TypedArrays) ---

  private wave!: Uint8Array;
  private compatible!: Int32Array;
  /** Final observed pattern index per cell. */
  protected observed!: Int32Array;

  private stack!: Int32Array;
  private stackSize: number = 0;
  private observedSoFar: number = 0;

  private weightLogWeights!: Float64Array;
  private distribution!: Float64Array;

  /** Number of remaining possible patterns per cell. */
  protected sumsOfOnes!: Int32Array;
  private sumsOfWeights!: Float64Array;
  private sumsOfWeightLogWeights!: Float64Array;
  private entropies!: Float64Array;

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
    heuristic: Heuristic,
  ) {
    this.MX = width;
    this.MY = height;
    this.N = N;
    this.periodic = periodic;
    this.heuristic = heuristic;
  }

  /**
   * Lazily allocate all working buffers. Called once before the first `run()`.
   * Separated from the constructor so subclasses can set `T`, `weights`, and
   * `propagator` first.
   */
  private init(): void {
    const cellCount = this.MX * this.MY;
    const T = this.T;

    this.wave = new Uint8Array(cellCount * T);
    this.compatible = new Int32Array(cellCount * T * 4);
    this.distribution = new Float64Array(T);
    this.observed = new Int32Array(cellCount);

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
      Math.log(this.sumOfWeights) - this.sumOfWeightLogWeights / this.sumOfWeights;

    this.sumsOfOnes = new Int32Array(cellCount);
    this.sumsOfWeights = new Float64Array(cellCount);
    this.sumsOfWeightLogWeights = new Float64Array(cellCount);
    this.entropies = new Float64Array(cellCount);

    // Worst case: every cell bans every pattern before propagation drains.
    this.stack = new Int32Array(cellCount * T * 2);
    this.stackSize = 0;
    this.initialized = true;
  }

  /**
   * Run the WFC algorithm to generate an output.
   *
   * The model can be reused: calling `run()` again with a different seed
   * resets all internal state and produces a fresh result.
   *
   * @param seed - Integer seed for the PRNG, enabling reproducible results.
   * @param limit - Maximum number of observe/propagate iterations.
   *   Use `-1` (default) for unlimited.
   * @returns A {@link WFCResult} with `success` flag and `observed` array.
   *
   * @example
   * ```ts
   * const result = model.run(42);
   * if (result.success) {
   *   const pixels = model.renderToBuffer(result);
   * }
   * ```
   */
  run(seed: number, limit: number = -1): WFCResult {
    if (!this.initialized) this.init();

    this.clear();
    const random = new Random(seed);

    for (let l = 0; l < limit || limit < 0; l++) {
      const node = this.nextUnobservedNode(random);
      if (node >= 0) {
        this.observe(node, random);
        if (!this.propagate()) {
          return { success: false, observed: this.observed };
        }
      } else {
        // All cells collapsed — finalize observed array.
        this.finalizeObserved();
        return { success: true, observed: this.observed };
      }
    }

    return { success: true, observed: this.observed };
  }

  /**
   * After all cells have been determined, write the first remaining pattern
   * index into each `observed` slot.
   */
  private finalizeObserved(): void {
    const T = this.T;
    const wave = this.wave;
    const cellCount = this.MX * this.MY;
    for (let i = 0; i < cellCount; i++) {
      const base = i * T;
      for (let t = 0; t < T; t++) {
        if (wave[base + t]) {
          this.observed[i] = t;
          break;
        }
      }
    }
  }

  /**
   * Find the next cell to collapse.
   *
   * @returns Cell index, or -1 if all cells are collapsed.
   */
  private nextUnobservedNode(random: Random): number {
    const { MX, MY, N, periodic, sumsOfOnes, heuristic, entropies } = this;
    const cellCount = MX * MY;

    if (heuristic === Heuristic.Scanline) {
      for (let i = this.observedSoFar; i < cellCount; i++) {
        if (!periodic && ((i % MX) + N > MX || ((i / MX) | 0) + N > MY)) {
          continue;
        }
        if (sumsOfOnes[i] > 1) {
          this.observedSoFar = i + 1;
          return i;
        }
      }
      return -1;
    }

    const useEntropy = heuristic === Heuristic.Entropy;
    let min = 1e4;
    let argmin = -1;

    for (let i = 0; i < cellCount; i++) {
      if (!periodic && ((i % MX) + N > MX || ((i / MX) | 0) + N > MY)) {
        continue;
      }
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

  /**
   * Collapse a cell to a single pattern, chosen by weighted random selection.
   */
  private observe(node: number, random: Random): void {
    const T = this.T;
    const wave = this.wave;
    const distribution = this.distribution;
    const base = node * T;

    for (let t = 0; t < T; t++) {
      distribution[t] = wave[base + t] ? this.weights[t] : 0.0;
    }

    const chosen = weightedRandom(distribution, random.nextDouble());

    for (let t = 0; t < T; t++) {
      if (wave[base + t] && t !== chosen) {
        this.ban(node, t);
      }
    }
  }

  /**
   * Constraint propagation (AC-4). Processes the stack of recently banned
   * (cell, pattern) pairs, removing patterns from neighbors whose compatible
   * count has dropped to zero.
   *
   * @returns `false` if a contradiction was detected (any cell has zero possibilities).
   */
  private propagate(): boolean {
    const { MX, MY, N, periodic, propagator, compatible } = this;
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

        if (!periodic && (x2 < 0 || y2 < 0 || x2 + N > MX || y2 + N > MY)) {
          continue;
        }

        if (x2 < 0) x2 += MX;
        else if (x2 >= MX) x2 -= MX;
        if (y2 < 0) y2 += MY;
        else if (y2 >= MY) y2 -= MY;

        const i2 = x2 + y2 * MX;
        const p = propagator[d][t1];
        const compatBase = i2 * T;

        for (let l = 0; l < p.length; l++) {
          const t2 = p[l];
          const compIdx = (compatBase + t2) * 4 + d;
          compatible[compIdx]--;
          if (compatible[compIdx] === 0) this.ban(i2, t2);
        }
      }
    }

    return this.sumsOfOnes[0] > 0;
  }

  /**
   * Ban a pattern from a cell: mark it impossible, update entropy accumulators,
   * and push onto the propagation stack.
   */
  private ban(i: number, t: number): void {
    const T = this.T;
    this.wave[i * T + t] = 0;

    // Zero out all compatible counts so propagation ignores this entry.
    const compBase = (i * T + t) * 4;
    const compatible = this.compatible;
    compatible[compBase] = 0;
    compatible[compBase + 1] = 0;
    compatible[compBase + 2] = 0;
    compatible[compBase + 3] = 0;

    // Push to propagation stack.
    const si = this.stackSize * 2;
    this.stack[si] = i;
    this.stack[si + 1] = t;
    this.stackSize++;

    // Update Shannon entropy accumulators for this cell.
    this.sumsOfOnes[i]--;
    this.sumsOfWeights[i] -= this.weights[t];
    this.sumsOfWeightLogWeights[i] -= this.weightLogWeights[t];

    const sum = this.sumsOfWeights[i];
    this.entropies[i] = Math.log(sum) - this.sumsOfWeightLogWeights[i] / sum;
  }

  /**
   * Reset all cells to the fully superposed state and apply initial constraints
   * (neighborless pattern bans + ground constraint).
   */
  private clear(): void {
    const cellCount = this.MX * this.MY;
    const T = this.T;
    const { wave, compatible, propagator } = this;

    for (let i = 0; i < cellCount; i++) {
      const wBase = i * T;
      for (let t = 0; t < T; t++) {
        wave[wBase + t] = 1;
        const compBase = (wBase + t) * 4;
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

    // Pre-ban patterns that have zero compatible neighbors in any direction.
    const { MX, MY, N, periodic } = this;
    for (let y = 0; y < MY; y++) {
      for (let x = 0; x < MX; x++) {
        if (!periodic && (x + N > MX || y + N > MY)) continue;
        const i = x + y * MX;
        for (let t = 0; t < T; t++) {
          const noRight = (periodic || x < MX - N) && propagator[2][t].length === 0;
          const noTop = (periodic || y > 0) && propagator[3][t].length === 0;
          const noLeft = (periodic || x > 0) && propagator[0][t].length === 0;
          const noBottom = (periodic || y < MY - N) && propagator[1][t].length === 0;
          if (noRight || noTop || noLeft || noBottom) this.ban(i, t);
        }
      }
    }

    // Ground constraint: pin last pattern to bottom row, forbid it elsewhere.
    if (this.ground) {
      for (let x = 0; x < MX; x++) {
        const bottom = x + (MY - 1) * MX;
        for (let t = 0; t < T - 1; t++) {
          if (wave[bottom * T + t]) this.ban(bottom, t);
        }
        for (let y = 0; y < MY - 1; y++) {
          const idx = x + y * MX;
          if (wave[idx * T + (T - 1)]) this.ban(idx, T - 1);
        }
      }
    }

    if (this.stackSize > 0) this.propagate();
  }

  /**
   * Read the wave state for a single cell.
   *
   * Returns a `Uint8Array` subarray (shared memory, not a copy) where
   * index `t` is `1` if pattern `t` is still possible and `0` if banned.
   *
   * @param cellIndex - Flat cell index (x + y * width).
   */
  getWave(cellIndex: number): Uint8Array {
    const base = cellIndex * this.T;
    return this.wave.subarray(base, base + this.T);
  }

  /**
   * Get the per-cell sum-of-weights array (shared memory, not a copy).
   * Useful for rendering partial/uncollapsed results.
   */
  getSumsOfWeights(): Float64Array {
    return this.sumsOfWeights;
  }
}
