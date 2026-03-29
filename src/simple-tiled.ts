// Copyright (C) 2016 Maxim Gumin, The MIT License (MIT)
// TypeScript port

import { Model } from "./model.js";
import {
  Heuristic,
  type NeighborRule,
  type SimpleTiledModelConfig,
  type TileConfig,
  type TileSymmetry,
  type WFCResult,
} from "./types.js";

/**
 * Simple Tiled Model: uses pre-defined tiles with explicit adjacency rules.
 *
 * Tiles can optionally carry pixel data for rendering.
 * If no pixel data is provided, use `observed` indices + `tilenames` to map results yourself.
 */
export class SimpleTiledModel extends Model {
  /** Pixel data for each tile variant (only populated if tile configs include pixels). */
  readonly tiles: Uint32Array[];
  /** Human-readable name for each tile variant (e.g. "grass 0", "cliff 1"). */
  readonly tilenames: string[];
  /** Tile pixel size (NxN pixels per tile). */
  readonly tileSize: number;

  constructor(config: SimpleTiledModelConfig) {
    const periodic = config.periodic ?? false;
    const heuristic = config.heuristic ?? Heuristic.Entropy;

    super(config.width, config.height, 1, periodic, heuristic);

    const subset = config.subset ? new Set(config.subset) : null;
    this.tileSize = config.tileSize ?? 1;

    this.tiles = [];
    this.tilenames = [];
    const weightList: number[] = [];
    const action: Int32Array[] = [];
    const firstOccurrence = new Map<string, number>();

    for (const xtile of config.tiles) {
      if (subset && !subset.has(xtile.name)) continue;

      const sym: TileSymmetry = xtile.symmetry ?? "X";
      let a: (i: number) => number;
      let b: (i: number) => number;
      let cardinality: number;

      switch (sym) {
        case "L":
          cardinality = 4;
          a = (i) => (i + 1) % 4;
          b = (i) => (i % 2 === 0 ? i + 1 : i - 1);
          break;
        case "T":
          cardinality = 4;
          a = (i) => (i + 1) % 4;
          b = (i) => (i % 2 === 0 ? i : 4 - i);
          break;
        case "I":
          cardinality = 2;
          a = (i) => 1 - i;
          b = (i) => i;
          break;
        case "\\":
          cardinality = 2;
          a = (i) => 1 - i;
          b = (i) => 1 - i;
          break;
        case "F":
          cardinality = 8;
          a = (i) => (i < 4 ? (i + 1) % 4 : 4 + ((i - 1) % 4));
          b = (i) => (i < 4 ? i + 4 : i - 4);
          break;
        default:
          // "X"
          cardinality = 1;
          a = (i) => i;
          b = (i) => i;
          break;
      }

      const T = action.length;
      firstOccurrence.set(xtile.name, T);

      for (let t = 0; t < cardinality; t++) {
        const map = new Int32Array(8);
        map[0] = t;
        map[1] = a(t);
        map[2] = a(a(t));
        map[3] = a(a(a(t)));
        map[4] = b(t);
        map[5] = b(a(t));
        map[6] = b(a(a(t)));
        map[7] = b(a(a(a(t))));

        for (let s = 0; s < 8; s++) map[s] += T;
        action.push(map);
      }

      // Handle tile pixel data
      if (xtile.pixels) {
        if (Array.isArray(xtile.pixels)) {
          // Pre-rotated variants provided
          for (let t = 0; t < cardinality; t++) {
            this.tiles.push(xtile.pixels[t]);
            this.tilenames.push(`${xtile.name} ${t}`);
          }
        } else {
          // Single image, compute rotations
          const sz = this.tileSize;
          this.tiles.push(xtile.pixels);
          this.tilenames.push(`${xtile.name} 0`);

          for (let t = 1; t < cardinality; t++) {
            if (t <= 3) {
              this.tiles.push(
                rotateTile(this.tiles[T + t - 1], sz)
              );
            }
            if (t >= 4) {
              this.tiles.push(
                reflectTile(this.tiles[T + t - 4], sz)
              );
            }
            this.tilenames.push(`${xtile.name} ${t}`);
          }
        }
      } else {
        // No pixel data — just track names
        for (let t = 0; t < cardinality; t++) {
          this.tiles.push(new Uint32Array(0));
          this.tilenames.push(`${xtile.name} ${t}`);
        }
      }

      const w = xtile.weight ?? 1.0;
      for (let t = 0; t < cardinality; t++) weightList.push(w);
    }

    this.T = action.length;
    this.weights = new Float64Array(weightList);
    this.ground = config.ground ?? false;

    // Build propagator via dense → sparse conversion
    const TT = this.T;

    // Dense propagator: denseProp[d * TT * TT + t1 * TT + t2]
    const denseSize = 4 * TT * TT;
    const denseProp = new Uint8Array(denseSize);

    for (const xn of config.neighbors) {
      if (subset && (!subset.has(xn.left) || !subset.has(xn.right)))
        continue;

      const leftFirst = firstOccurrence.get(xn.left);
      const rightFirst = firstOccurrence.get(xn.right);
      if (leftFirst === undefined || rightFirst === undefined) continue;

      const L =
        action[leftFirst][xn.leftRotation ?? 0];
      const D = action[L][1];
      const R =
        action[rightFirst][xn.rightRotation ?? 0];
      const U = action[R][1];

      // Direction 0 (left): R can be left of L
      denseProp[0 * TT * TT + R * TT + L] = 1;
      denseProp[0 * TT * TT + action[R][6] * TT + action[L][6]] = 1;
      denseProp[0 * TT * TT + action[L][4] * TT + action[R][4]] = 1;
      denseProp[0 * TT * TT + action[L][2] * TT + action[R][2]] = 1;

      // Direction 1 (down): U is below D
      denseProp[1 * TT * TT + U * TT + D] = 1;
      denseProp[1 * TT * TT + action[D][6] * TT + action[U][6]] = 1;
      denseProp[1 * TT * TT + action[U][4] * TT + action[D][4]] = 1;
      denseProp[1 * TT * TT + action[D][2] * TT + action[U][2]] = 1;
    }

    // Directions 2 and 3 are transposes of 0 and 1
    for (let t2 = 0; t2 < TT; t2++) {
      for (let t1 = 0; t1 < TT; t1++) {
        denseProp[2 * TT * TT + t2 * TT + t1] =
          denseProp[0 * TT * TT + t1 * TT + t2];
        denseProp[3 * TT * TT + t2 * TT + t1] =
          denseProp[1 * TT * TT + t1 * TT + t2];
      }
    }

    // Convert dense → sparse
    this.propagator = new Array(4);
    for (let d = 0; d < 4; d++) {
      this.propagator[d] = new Array(TT);
      const dBase = d * TT * TT;
      for (let t1 = 0; t1 < TT; t1++) {
        const list: number[] = [];
        const rowBase = dBase + t1 * TT;
        for (let t2 = 0; t2 < TT; t2++) {
          if (denseProp[rowBase + t2]) list.push(t2);
        }
        this.propagator[d][t1] = new Int32Array(list);
      }
    }
  }

  /**
   * Render a completed (or partial) result to an RGBA pixel buffer.
   * Only works if tile pixel data was provided in the config.
   * @param result - The WFCResult from run().
   * @returns Uint32Array of RGBA pixels (width*tileSize * height*tileSize).
   */
  renderToBuffer(result: WFCResult): Uint32Array {
    const MX = this.MX;
    const MY = this.MY;
    const ts = this.tileSize;
    const bitmap = new Uint32Array(MX * MY * ts * ts);
    const observed = result.observed;
    const tiles = this.tiles;

    if (observed[0] >= 0) {
      for (let y = 0; y < MY; y++) {
        for (let x = 0; x < MX; x++) {
          const tile = tiles[observed[x + y * MX]];
          if (tile.length === 0) continue;
          for (let dy = 0; dy < ts; dy++) {
            for (let dx = 0; dx < ts; dx++) {
              bitmap[x * ts + dx + (y * ts + dy) * MX * ts] =
                tile[dx + dy * ts];
            }
          }
        }
      }
    } else {
      // Partial: weighted average of possible tile pixels
      for (let i = 0; i < MX * MY; i++) {
        const x = i % MX;
        const y = (i / MX) | 0;
        const wave = this.getWave(i);
        const sumW = this.getSumsOfWeights()[i];
        if (sumW === 0) continue;
        const norm = 1.0 / sumW;

        for (let yt = 0; yt < ts; yt++) {
          for (let xt = 0; xt < ts; xt++) {
            let r = 0, g = 0, b = 0;
            for (let t = 0; t < this.T; t++) {
              if (!wave[t]) continue;
              const tile = tiles[t];
              if (tile.length === 0) continue;
              const argb = tile[xt + yt * ts];
              r += ((argb >>> 16) & 0xff) * this.weights[t] * norm;
              g += ((argb >>> 8) & 0xff) * this.weights[t] * norm;
              b += (argb & 0xff) * this.weights[t] * norm;
            }
            bitmap[x * ts + xt + (y * ts + yt) * MX * ts] =
              0xff000000 | ((r | 0) << 16) | ((g | 0) << 8) | (b | 0);
          }
        }
      }
    }

    return bitmap;
  }

  /**
   * Get text output mapping each cell to its tile name.
   * @param result - The WFCResult from run().
   * @returns 2D array of tile name strings [y][x].
   */
  textOutput(result: WFCResult): string[][] {
    const MX = this.MX;
    const MY = this.MY;
    const rows: string[][] = [];
    for (let y = 0; y < MY; y++) {
      const row: string[] = [];
      for (let x = 0; x < MX; x++) {
        row.push(this.tilenames[result.observed[x + y * MX]]);
      }
      rows.push(row);
    }
    return rows;
  }
}

function rotateTile(array: Uint32Array, size: number): Uint32Array {
  const result = new Uint32Array(size * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      result[x + y * size] = array[size - 1 - y + x * size];
  return result;
}

function reflectTile(array: Uint32Array, size: number): Uint32Array {
  const result = new Uint32Array(size * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      result[x + y * size] = array[size - 1 - x + y * size];
  return result;
}
