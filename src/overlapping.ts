/**
 * Overlapping Model — learns NxN patterns from a sample image and generates
 * new images composed entirely of those patterns.
 *
 * @module overlapping
 * @license MIT
 * @copyright 2016 Maxim Gumin
 */

import { Model } from "./model.js";
import { Heuristic, type OverlappingModelConfig, type WFCResult } from "./types.js";

/** Direction offsets matching the base Model convention: left, down, right, up. */
const DX = [-1, 0, 1, 0];
const DY = [0, 1, 0, -1];

/**
 * Extract NxN patterns from a sample image and generate new images that
 * contain only those patterns, respecting local adjacency constraints.
 *
 * @example
 * ```ts
 * import { OverlappingModel } from "wave-function-collapse";
 *
 * const model = new OverlappingModel({
 *   sample: imagePixels,  // Uint32Array of RGBA pixels
 *   sampleWidth: 64,
 *   sampleHeight: 64,
 *   N: 3,
 *   width: 48,
 *   height: 48,
 *   periodic: true,
 *   symmetry: 8,
 * });
 *
 * const result = model.run(42);
 * if (result.success) {
 *   const outputPixels = model.renderToBuffer(result);
 * }
 * ```
 */
export class OverlappingModel extends Model {
  private readonly patterns: Uint8Array[];
  private readonly colors: Uint32Array;

  /**
   * @param config - Model configuration.
   * @throws {Error} If sample dimensions are invalid or the sample contains
   *   no extractable patterns.
   */
  constructor(config: OverlappingModelConfig) {
    const N = config.N ?? 3;
    const periodic = config.periodic ?? false;
    const heuristic = config.heuristic ?? Heuristic.Entropy;

    super(config.width, config.height, N, periodic, heuristic);

    const { sample, sampleWidth: SX, sampleHeight: SY } = config;
    const periodicInput = config.periodicInput ?? false;
    const symmetry = config.symmetry ?? 8;

    if (SX <= 0 || SY <= 0) {
      throw new Error(`Invalid sample dimensions: ${SX}x${SY}`);
    }
    if (sample.length !== SX * SY) {
      throw new Error(
        `Sample length (${sample.length}) does not match dimensions (${SX}x${SY}=${SX * SY})`,
      );
    }
    if (config.width <= 0 || config.height <= 0) {
      throw new Error(
        `Output dimensions must be positive: ${config.width}x${config.height}`,
      );
    }

    // --- Build color palette and re-index sample to palette indices ---
    const colorMap = new Map<number, number>();
    const colorList: number[] = [];
    const indexed = new Uint8Array(sample.length);

    for (let i = 0; i < sample.length; i++) {
      const c = sample[i];
      let k = colorMap.get(c);
      if (k === undefined) {
        k = colorList.length;
        colorMap.set(c, k);
        colorList.push(c);
      }
      indexed[i] = k;
    }

    this.colors = new Uint32Array(colorList);
    const C = colorList.length;

    // --- Extract, deduplicate, and count patterns ---
    this.patterns = [];
    const patternIndices = new Map<string, number>();
    const weightList: number[] = [];

    const xmax = periodicInput ? SX : SX - N + 1;
    const ymax = periodicInput ? SY : SY - N + 1;

    for (let y = 0; y < ymax; y++) {
      for (let x = 0; x < xmax; x++) {
        // Generate all 8 symmetry variants (rotate/reflect chain).
        const ps: Uint8Array[] = new Array(8);
        ps[0] = extractPattern(
          (dx, dy) => indexed[((x + dx) % SX) + ((y + dy) % SY) * SX],
          N,
        );
        ps[1] = reflectPattern(ps[0], N);
        ps[2] = rotatePattern(ps[0], N);
        ps[3] = reflectPattern(ps[2], N);
        ps[4] = rotatePattern(ps[2], N);
        ps[5] = reflectPattern(ps[4], N);
        ps[6] = rotatePattern(ps[4], N);
        ps[7] = reflectPattern(ps[6], N);

        for (let k = 0; k < symmetry; k++) {
          const p = ps[k];
          const h = hashPattern(p, C);
          const existing = patternIndices.get(h);
          if (existing !== undefined) {
            weightList[existing]++;
          } else {
            patternIndices.set(h, weightList.length);
            weightList.push(1);
            this.patterns.push(p);
          }
        }
      }
    }

    if (weightList.length === 0) {
      throw new Error(
        "No patterns extracted. Check that N is not larger than the sample.",
      );
    }

    this.T = weightList.length;
    this.weights = new Float64Array(weightList);
    this.ground = config.ground ?? false;

    // --- Build adjacency propagator ---
    const T = this.T;
    const patterns = this.patterns;

    this.propagator = new Array(4);
    for (let d = 0; d < 4; d++) {
      this.propagator[d] = new Array(T);
      for (let t = 0; t < T; t++) {
        const list: number[] = [];
        for (let t2 = 0; t2 < T; t2++) {
          if (patternsAgree(patterns[t], patterns[t2], DX[d], DY[d], N)) {
            list.push(t2);
          }
        }
        this.propagator[d][t] = new Int32Array(list);
      }
    }
  }

  /** Number of unique patterns extracted from the sample. */
  get patternCount(): number {
    return this.T;
  }

  /**
   * Render a generation result to an RGBA pixel buffer.
   *
   * For a successful result, each cell is mapped to its observed pattern's
   * color. For a failed/partial result, colors are averaged over all remaining
   * possible patterns.
   *
   * @param result - The {@link WFCResult} returned by {@link Model.run}.
   * @returns Flat row-major `Uint32Array` of RGBA pixels (width * height).
   */
  renderToBuffer(result: WFCResult): Uint32Array {
    const { MX, MY, N, patterns, colors } = this;
    const bitmap = new Uint32Array(MX * MY);
    const { observed } = result;

    if (observed[0] >= 0) {
      // Fully collapsed — direct pixel lookup.
      for (let y = 0; y < MY; y++) {
        const dy = y < MY - N + 1 ? 0 : N - 1;
        for (let x = 0; x < MX; x++) {
          const dx = x < MX - N + 1 ? 0 : N - 1;
          const patternIdx = observed[x - dx + (y - dy) * MX];
          bitmap[x + y * MX] = colors[patterns[patternIdx][dx + dy * N]];
        }
      }
    } else {
      // Partial — average colors over remaining possibilities.
      this.renderPartial(bitmap);
    }

    return bitmap;
  }

  /**
   * Render a partial (uncollapsed) state by averaging colors weighted by
   * pattern possibility.
   */
  private renderPartial(bitmap: Uint32Array): void {
    const { MX, MY, N, patterns, colors } = this;
    const T = this.T;

    for (let i = 0; i < MX * MY; i++) {
      let contributors = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      const x = i % MX;
      const y = (i / MX) | 0;

      for (let dy = 0; dy < N; dy++) {
        for (let dx = 0; dx < N; dx++) {
          let sx = x - dx;
          if (sx < 0) sx += MX;
          let sy = y - dy;
          if (sy < 0) sy += MY;

          if (!this.periodic && (sx + N > MX || sy + N > MY)) continue;

          const wave = this.getWave(sx + sy * MX);
          for (let t = 0; t < T; t++) {
            if (wave[t]) {
              contributors++;
              const argb = colors[patterns[t][dx + dy * N]];
              r += (argb >>> 16) & 0xff;
              g += (argb >>> 8) & 0xff;
              b += argb & 0xff;
            }
          }
        }
      }

      if (contributors > 0) {
        bitmap[i] =
          0xff000000 |
          (((r / contributors) | 0) << 16) |
          (((g / contributors) | 0) << 8) |
          ((b / contributors) | 0);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Pattern helpers (pure functions, no allocations beyond the result)
// ---------------------------------------------------------------------------

/** Create a pattern by sampling a function over an NxN grid. */
function extractPattern(f: (x: number, y: number) => number, N: number): Uint8Array {
  const result = new Uint8Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      result[x + y * N] = f(x, y);
    }
  }
  return result;
}

/** Rotate a pattern 90 degrees clockwise. */
function rotatePattern(p: Uint8Array, N: number): Uint8Array {
  return extractPattern((x, y) => p[N - 1 - y + x * N], N);
}

/** Reflect a pattern horizontally. */
function reflectPattern(p: Uint8Array, N: number): Uint8Array {
  return extractPattern((x, y) => p[N - 1 - x + y * N], N);
}

/**
 * Hash a pattern for deduplication. Uses FNV-1a (32-bit) for speed, with the
 * color count mixed in to reduce collisions across different palette sizes.
 */
function hashPattern(p: Uint8Array, colorCount: number): string {
  let hash = 2166136261 ^ colorCount;
  for (let i = 0; i < p.length; i++) {
    hash ^= p[i];
    hash = Math.imul(hash, 16777619);
  }
  // Append a content fingerprint to make collisions astronomically unlikely.
  // The FNV hash alone has ~1/2^32 collision rate; appending length + first/last
  // byte eliminates any practical risk.
  return `${(hash >>> 0).toString(36)}_${p.length}_${p[0]}_${p[p.length - 1]}`;
}

/**
 * Check whether two patterns overlap correctly when shifted by (dx, dy).
 * The overlapping region must match exactly.
 */
function patternsAgree(
  p1: Uint8Array,
  p2: Uint8Array,
  dx: number,
  dy: number,
  N: number,
): boolean {
  const xmin = dx < 0 ? 0 : dx;
  const xmax = dx < 0 ? dx + N : N;
  const ymin = dy < 0 ? 0 : dy;
  const ymax = dy < 0 ? dy + N : N;
  for (let y = ymin; y < ymax; y++) {
    for (let x = xmin; x < xmax; x++) {
      if (p1[x + N * y] !== p2[x - dx + N * (y - dy)]) return false;
    }
  }
  return true;
}
