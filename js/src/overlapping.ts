// Copyright (C) 2016 Maxim Gumin, The MIT License (MIT)
// TypeScript port

import { Model } from "./model.js";
import {
  Heuristic,
  type OverlappingModelConfig,
  type WFCResult,
} from "./types.js";

/**
 * Overlapping Model: learns NxN patterns from a sample image and
 * generates new images containing only those patterns.
 *
 * Input: a flat Uint32Array of RGBA pixels + dimensions.
 * Output: observed pattern indices per cell. Use `renderToBuffer()` to get pixels.
 */
export class OverlappingModel extends Model {
  private patterns: Uint8Array[];
  private colors: Uint32Array;

  constructor(config: OverlappingModelConfig) {
    const N = config.N ?? 3;
    const periodic = config.periodic ?? false;
    const heuristic = config.heuristic ?? Heuristic.Entropy;

    super(config.width, config.height, N, periodic, heuristic);

    const sample = config.sample;
    const SX = config.sampleWidth;
    const SY = config.sampleHeight;
    const periodicInput = config.periodicInput ?? false;
    const symmetry = config.symmetry ?? 8;

    // Build color palette and index sample
    const colorList: number[] = [];
    const colorMap = new Map<number, number>();
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

    // Pattern helpers
    function pattern(
      f: (x: number, y: number) => number,
      N: number
    ): Uint8Array {
      const result = new Uint8Array(N * N);
      for (let y = 0; y < N; y++)
        for (let x = 0; x < N; x++) result[x + y * N] = f(x, y);
      return result;
    }

    function rotate(p: Uint8Array, N: number): Uint8Array {
      return pattern((x, y) => p[N - 1 - y + x * N], N);
    }

    function reflect(p: Uint8Array, N: number): Uint8Array {
      return pattern((x, y) => p[N - 1 - x + y * N], N);
    }

    // Use a string hash for pattern deduplication (BigInt hashing has overhead)
    function hashPattern(p: Uint8Array): string {
      // For small patterns (N<=5, C<256) this is fast enough and collision-free
      // Using a numeric hash for larger patterns
      if (p.length <= 25) {
        let result = 0n;
        let power = 1n;
        const bigC = BigInt(C);
        for (let i = p.length - 1; i >= 0; i--) {
          result += BigInt(p[i]) * power;
          power *= bigC;
        }
        return result.toString(36);
      }
      // Fallback: join bytes
      return p.join(",");
    }

    this.patterns = [];
    const patternIndices = new Map<string, number>();
    const weightList: number[] = [];

    const xmax = periodicInput ? SX : SX - N + 1;
    const ymax = periodicInput ? SY : SY - N + 1;

    for (let y = 0; y < ymax; y++) {
      for (let x = 0; x < xmax; x++) {
        const ps: Uint8Array[] = new Array(8);

        ps[0] = pattern(
          (dx, dy) => indexed[(x + dx) % SX + ((y + dy) % SY) * SX],
          N
        );
        ps[1] = reflect(ps[0], N);
        ps[2] = rotate(ps[0], N);
        ps[3] = reflect(ps[2], N);
        ps[4] = rotate(ps[2], N);
        ps[5] = reflect(ps[4], N);
        ps[6] = rotate(ps[4], N);
        ps[7] = reflect(ps[6], N);

        for (let k = 0; k < symmetry; k++) {
          const p = ps[k];
          const h = hashPattern(p);
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

    this.T = weightList.length;
    this.weights = new Float64Array(weightList);
    this.ground = config.ground ?? false;

    // Build propagator
    function agrees(
      p1: Uint8Array,
      p2: Uint8Array,
      dx: number,
      dy: number,
      N: number
    ): boolean {
      const xmin = dx < 0 ? 0 : dx;
      const xmax = dx < 0 ? dx + N : N;
      const ymin = dy < 0 ? 0 : dy;
      const ymax = dy < 0 ? dy + N : N;
      for (let y = ymin; y < ymax; y++)
        for (let x = xmin; x < xmax; x++)
          if (p1[x + N * y] !== p2[x - dx + N * (y - dy)]) return false;
      return true;
    }

    const DX = [-1, 0, 1, 0];
    const DY = [0, 1, 0, -1];
    const T = this.T;
    const patterns = this.patterns;

    this.propagator = new Array(4);
    for (let d = 0; d < 4; d++) {
      this.propagator[d] = new Array(T);
      for (let t = 0; t < T; t++) {
        const list: number[] = [];
        for (let t2 = 0; t2 < T; t2++) {
          if (agrees(patterns[t], patterns[t2], DX[d], DY[d], N)) {
            list.push(t2);
          }
        }
        this.propagator[d][t] = new Int32Array(list);
      }
    }
  }

  /** Number of unique patterns extracted. */
  get patternCount(): number {
    return this.T;
  }

  /**
   * Render a completed (or partial) result to an RGBA pixel buffer.
   * @param result - The WFCResult from run().
   * @returns Uint32Array of RGBA pixels (width * height).
   */
  renderToBuffer(result: WFCResult): Uint32Array {
    const MX = this.MX;
    const MY = this.MY;
    const N = this.N;
    const bitmap = new Uint32Array(MX * MY);
    const observed = result.observed;
    const patterns = this.patterns;
    const colors = this.colors;

    if (observed[0] >= 0) {
      for (let y = 0; y < MY; y++) {
        const dy = y < MY - N + 1 ? 0 : N - 1;
        for (let x = 0; x < MX; x++) {
          const dx = x < MX - N + 1 ? 0 : N - 1;
          bitmap[x + y * MX] =
            colors[patterns[observed[x - dx + (y - dy) * MX]][dx + dy * N]];
        }
      }
    } else {
      // Partial result: average colors weighted by possibility
      for (let i = 0; i < MX * MY; i++) {
        let contributors = 0;
        let r = 0,
          g = 0,
          b = 0;
        const x = i % MX;
        const y = (i / MX) | 0;

        for (let dy = 0; dy < N; dy++) {
          for (let dx = 0; dx < N; dx++) {
            let sx = x - dx;
            if (sx < 0) sx += MX;
            let sy = y - dy;
            if (sy < 0) sy += MY;

            const s = sx + sy * MX;
            if (
              !this.periodic &&
              (sx + N > MX || sy + N > MY || sx < 0 || sy < 0)
            )
              continue;

            const wave = this.getWave(s);
            for (let t = 0; t < this.T; t++) {
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

    return bitmap;
  }
}
