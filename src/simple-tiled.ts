/**
 * Simple Tiled Model — procedural generation using pre-defined tiles with
 * explicit adjacency rules.
 *
 * @module simple-tiled
 * @license MIT
 * @copyright 2016 Maxim Gumin
 */

import { Model } from "./model.js";
import {
  Heuristic,
  type SimpleTiledModelConfig,
  type TileSymmetry,
  type WFCResult,
} from "./types.js";

/**
 * Generate tile-based layouts using explicit adjacency constraints.
 *
 * Each tile has a symmetry type that determines how many orientation variants
 * are created. Neighbor rules specify which tile orientations can be adjacent,
 * and the symmetry system automatically expands them into all equivalent pairs.
 *
 * @example
 * ```ts
 * import { SimpleTiledModel } from "wave-function-collapse";
 *
 * const model = new SimpleTiledModel({
 *   tiles: [
 *     { name: "grass", symmetry: "X", weight: 2 },
 *     { name: "road", symmetry: "I", weight: 1 },
 *   ],
 *   neighbors: [
 *     { left: "grass", right: "grass" },
 *     { left: "grass", right: "road" },
 *     { left: "road", right: "road" },
 *   ],
 *   width: 20,
 *   height: 20,
 * });
 *
 * const result = model.run(42);
 * if (result.success) {
 *   const grid = model.textOutput(result); // string[][]
 * }
 * ```
 */
export class SimpleTiledModel extends Model {
  /** Pixel data for each tile variant (empty if pixel data was not provided). */
  readonly tiles: Uint32Array[];
  /** Human-readable name for each tile variant (e.g. `"road 2"`). */
  readonly tilenames: string[];
  /** Pixel dimensions of each tile (width = height = tileSize). */
  readonly tileSize: number;

  /**
   * @param config - Model configuration.
   * @throws {Error} If the configuration is invalid (empty tiles, bad dimensions,
   *   unknown tile names in neighbor rules, etc.).
   */
  constructor(config: SimpleTiledModelConfig) {
    const periodic = config.periodic ?? false;
    const heuristic = config.heuristic ?? Heuristic.Entropy;

    super(config.width, config.height, 1, periodic, heuristic);

    if (config.width <= 0 || config.height <= 0) {
      throw new Error(
        `Output dimensions must be positive: ${config.width}x${config.height}`,
      );
    }
    if (config.tiles.length === 0) {
      throw new Error("At least one tile must be provided.");
    }
    if (config.neighbors.length === 0) {
      throw new Error("At least one neighbor rule must be provided.");
    }

    const subset = config.subset ? new Set(config.subset) : null;
    this.tileSize = config.tileSize ?? 1;

    this.tiles = [];
    this.tilenames = [];
    const weightList: number[] = [];

    // Action maps: for each tile variant, stores 8 indices representing the
    // result of each dihedral group action (4 rotations × 2 reflections).
    const action: Int32Array[] = [];
    const firstOccurrence = new Map<string, number>();

    for (const tileDef of config.tiles) {
      if (subset && !subset.has(tileDef.name)) continue;

      const sym: TileSymmetry = tileDef.symmetry ?? "X";
      const { a, b, cardinality } = getSymmetryFunctions(sym);

      const baseIndex = action.length;
      firstOccurrence.set(tileDef.name, baseIndex);

      // Build action map for each cardinality variant.
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

        for (let s = 0; s < 8; s++) map[s] += baseIndex;
        action.push(map);
      }

      // Register tile pixel data (or empty placeholders).
      this.registerTilePixels(tileDef, cardinality, baseIndex);

      const w = tileDef.weight ?? 1.0;
      for (let t = 0; t < cardinality; t++) weightList.push(w);
    }

    this.T = action.length;
    this.weights = new Float64Array(weightList);
    this.ground = config.ground ?? false;

    // --- Build propagator via dense → sparse conversion ---
    this.buildPropagator(config, action, firstOccurrence, subset);
  }

  /**
   * Register tile pixel data for all orientation variants of a tile definition.
   */
  private registerTilePixels(
    tileDef: { name: string; pixels?: Uint32Array | Uint32Array[] },
    cardinality: number,
    baseIndex: number,
  ): void {
    if (tileDef.pixels) {
      if (Array.isArray(tileDef.pixels)) {
        for (let t = 0; t < cardinality; t++) {
          this.tiles.push(tileDef.pixels[t]);
          this.tilenames.push(`${tileDef.name} ${t}`);
        }
      } else {
        const sz = this.tileSize;
        this.tiles.push(tileDef.pixels);
        this.tilenames.push(`${tileDef.name} 0`);

        for (let t = 1; t < cardinality; t++) {
          if (t <= 3) {
            this.tiles.push(rotateTile(this.tiles[baseIndex + t - 1], sz));
          }
          if (t >= 4) {
            this.tiles.push(reflectTile(this.tiles[baseIndex + t - 4], sz));
          }
          this.tilenames.push(`${tileDef.name} ${t}`);
        }
      }
    } else {
      for (let t = 0; t < cardinality; t++) {
        this.tiles.push(new Uint32Array(0));
        this.tilenames.push(`${tileDef.name} ${t}`);
      }
    }
  }

  /**
   * Build the sparse propagator from neighbor rules.
   *
   * 1. Populate a dense boolean matrix (4 directions × T × T).
   * 2. Expand each canonical neighbor rule into all symmetric equivalents.
   * 3. Derive opposite-direction rules by transposition.
   * 4. Convert to sparse (Int32Array per direction/pattern).
   */
  private buildPropagator(
    config: SimpleTiledModelConfig,
    action: Int32Array[],
    firstOccurrence: Map<string, number>,
    subset: Set<string> | null,
  ): void {
    const TT = this.T;
    const denseProp = new Uint8Array(4 * TT * TT);

    for (const rule of config.neighbors) {
      if (subset && (!subset.has(rule.left) || !subset.has(rule.right))) {
        continue;
      }

      const leftFirst = firstOccurrence.get(rule.left);
      const rightFirst = firstOccurrence.get(rule.right);
      if (leftFirst === undefined || rightFirst === undefined) continue;

      const L = action[leftFirst][rule.leftRotation ?? 0];
      const D = action[L][1];
      const R = action[rightFirst][rule.rightRotation ?? 0];
      const U = action[R][1];

      // Expand into all 4 symmetric equivalents for direction 0 (left).
      const d0 = 0 * TT * TT;
      denseProp[d0 + R * TT + L] = 1;
      denseProp[d0 + action[R][6] * TT + action[L][6]] = 1;
      denseProp[d0 + action[L][4] * TT + action[R][4]] = 1;
      denseProp[d0 + action[L][2] * TT + action[R][2]] = 1;

      // Expand for direction 1 (down).
      const d1 = 1 * TT * TT;
      denseProp[d1 + U * TT + D] = 1;
      denseProp[d1 + action[D][6] * TT + action[U][6]] = 1;
      denseProp[d1 + action[U][4] * TT + action[D][4]] = 1;
      denseProp[d1 + action[D][2] * TT + action[U][2]] = 1;
    }

    // Directions 2 (right) and 3 (up) are transposes of 0 and 1.
    for (let t2 = 0; t2 < TT; t2++) {
      for (let t1 = 0; t1 < TT; t1++) {
        denseProp[2 * TT * TT + t2 * TT + t1] = denseProp[0 * TT * TT + t1 * TT + t2];
        denseProp[3 * TT * TT + t2 * TT + t1] = denseProp[1 * TT * TT + t1 * TT + t2];
      }
    }

    // Convert dense → sparse propagator.
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
   * Render a generation result to an RGBA pixel buffer.
   *
   * Requires that tile pixel data was provided in the config. For a successful
   * result, each cell is rendered with its observed tile's pixels. For a
   * partial result, pixel colors are weight-averaged over all remaining
   * possible tiles.
   *
   * @param result - The {@link WFCResult} returned by {@link Model.run}.
   * @returns Flat row-major `Uint32Array` of RGBA pixels
   *   (width * tileSize × height * tileSize).
   */
  renderToBuffer(result: WFCResult): Uint32Array {
    const { MX, MY, tileSize: ts, tiles } = this;
    const bitmap = new Uint32Array(MX * MY * ts * ts);
    const { observed } = result;

    if (observed[0] >= 0) {
      for (let y = 0; y < MY; y++) {
        for (let x = 0; x < MX; x++) {
          const tile = tiles[observed[x + y * MX]];
          if (tile.length === 0) continue;
          for (let dy = 0; dy < ts; dy++) {
            for (let dx = 0; dx < ts; dx++) {
              bitmap[x * ts + dx + (y * ts + dy) * MX * ts] = tile[dx + dy * ts];
            }
          }
        }
      }
    } else {
      this.renderPartial(bitmap);
    }

    return bitmap;
  }

  /**
   * Render a partial (uncollapsed) state by weight-averaging tile pixel colors.
   */
  private renderPartial(bitmap: Uint32Array): void {
    const { MX, MY, tileSize: ts, tiles } = this;
    const T = this.T;

    for (let i = 0; i < MX * MY; i++) {
      const x = i % MX;
      const y = (i / MX) | 0;
      const wave = this.getWave(i);
      const sumW = this.getSumsOfWeights()[i];
      if (sumW === 0) continue;
      const norm = 1.0 / sumW;

      for (let yt = 0; yt < ts; yt++) {
        for (let xt = 0; xt < ts; xt++) {
          let r = 0;
          let g = 0;
          let b = 0;
          for (let t = 0; t < T; t++) {
            if (!wave[t]) continue;
            const tile = tiles[t];
            if (tile.length === 0) continue;
            const argb = tile[xt + yt * ts];
            const w = this.weights[t] * norm;
            r += ((argb >>> 16) & 0xff) * w;
            g += ((argb >>> 8) & 0xff) * w;
            b += (argb & 0xff) * w;
          }
          bitmap[x * ts + xt + (y * ts + yt) * MX * ts] =
            0xff000000 | ((r | 0) << 16) | ((g | 0) << 8) | (b | 0);
        }
      }
    }
  }

  /**
   * Get the tile name for each cell as a 2D grid.
   *
   * @param result - The {@link WFCResult} returned by {@link Model.run}.
   * @returns Grid of tile name strings indexed as `grid[y][x]`.
   */
  textOutput(result: WFCResult): string[][] {
    const { MX, MY, tilenames } = this;
    const grid: string[][] = [];
    for (let y = 0; y < MY; y++) {
      const row: string[] = [];
      for (let x = 0; x < MX; x++) {
        row.push(tilenames[result.observed[x + y * MX]]);
      }
      grid.push(row);
    }
    return grid;
  }
}

// ---------------------------------------------------------------------------
// Symmetry helpers
// ---------------------------------------------------------------------------

interface SymmetryInfo {
  a: (i: number) => number;
  b: (i: number) => number;
  cardinality: number;
}

/**
 * Return the rotation (`a`) and reflection (`b`) functions for a given
 * tile symmetry type, along with the number of distinct orientations.
 */
function getSymmetryFunctions(sym: TileSymmetry): SymmetryInfo {
  switch (sym) {
    case "L":
      return {
        cardinality: 4,
        a: (i) => (i + 1) % 4,
        b: (i) => (i % 2 === 0 ? i + 1 : i - 1),
      };
    case "T":
      return {
        cardinality: 4,
        a: (i) => (i + 1) % 4,
        b: (i) => (i % 2 === 0 ? i : 4 - i),
      };
    case "I":
      return {
        cardinality: 2,
        a: (i) => 1 - i,
        b: (i) => i,
      };
    case "\\":
      return {
        cardinality: 2,
        a: (i) => 1 - i,
        b: (i) => 1 - i,
      };
    case "F":
      return {
        cardinality: 8,
        a: (i) => (i < 4 ? (i + 1) % 4 : 4 + ((i - 1) % 4)),
        b: (i) => (i < 4 ? i + 4 : i - 4),
      };
    default:
      // "X" — fully symmetric
      return {
        cardinality: 1,
        a: (i) => i,
        b: (i) => i,
      };
  }
}

// ---------------------------------------------------------------------------
// Pixel rotation/reflection
// ---------------------------------------------------------------------------

/** Rotate tile pixel data 90 degrees clockwise. */
function rotateTile(array: Uint32Array, size: number): Uint32Array {
  const result = new Uint32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      result[x + y * size] = array[size - 1 - y + x * size];
    }
  }
  return result;
}

/** Reflect tile pixel data horizontally. */
function reflectTile(array: Uint32Array, size: number): Uint32Array {
  const result = new Uint32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      result[x + y * size] = array[size - 1 - x + y * size];
    }
  }
  return result;
}
