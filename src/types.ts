/**
 * Public type definitions for the Wave Function Collapse library.
 *
 * @module types
 * @license MIT
 * @copyright 2016 Maxim Gumin
 */

/**
 * Heuristic for selecting the next cell to collapse during the
 * observation step.
 *
 * - `Entropy` — Shannon entropy. Best output quality, slightly slower.
 * - `MRV` — Minimum Remaining Values. Fast with good quality.
 * - `Scanline` — Sequential left-to-right, top-to-bottom. Fastest, lowest quality.
 *
 * @example
 * ```ts
 * import { Heuristic } from "wave-function-collapse";
 * const model = new OverlappingModel({ ..., heuristic: Heuristic.Entropy });
 * ```
 */
export enum Heuristic {
  Entropy = 0,
  MRV = 1,
  Scanline = 2,
}

/**
 * Tile symmetry type for {@link SimpleTiledModel}.
 *
 * Determines how many orientation variants a tile produces:
 * - `"X"` — 1 variant (fully symmetric, e.g. grass)
 * - `"I"` — 2 variants (180-degree symmetry, e.g. straight road)
 * - `"T"` — 4 variants (T-shaped)
 * - `"L"` — 4 variants (corner / L-shaped)
 * - `"\\"` — 2 variants (diagonal symmetry)
 * - `"F"` — 8 variants (fully asymmetric)
 */
export type TileSymmetry = "X" | "I" | "T" | "L" | "\\" | "F";

/**
 * A tile definition for {@link SimpleTiledModel}.
 *
 * @example
 * ```ts
 * const grass: TileConfig = { name: "grass", symmetry: "X", weight: 2 };
 * const road: TileConfig = { name: "road", symmetry: "I", weight: 1, pixels: roadPixels };
 * ```
 */
export interface TileConfig {
  /** Unique name identifying this tile type. */
  name: string;

  /**
   * Symmetry type controlling how many orientation variants are generated.
   * @defaultValue `"X"`
   */
  symmetry?: TileSymmetry;

  /**
   * Relative weight / probability. Higher values make this tile appear more often.
   * @defaultValue `1`
   */
  weight?: number;

  /**
   * Optional RGBA pixel data for rendering.
   *
   * - **Single `Uint32Array`**: one base image; rotations/reflections are computed
   *   automatically from the symmetry type.
   * - **`Uint32Array[]`**: pre-rotated variants (length must equal the symmetry
   *   cardinality).
   */
  pixels?: Uint32Array | Uint32Array[];
}

/**
 * An adjacency (neighbor) rule for {@link SimpleTiledModel}.
 *
 * Defines that the `left` tile (at orientation `leftRotation`) can appear
 * immediately to the left of the `right` tile (at orientation `rightRotation`).
 * The symmetry system automatically expands this into all equivalent
 * rotated/reflected pairs.
 *
 * @example
 * ```ts
 * const rule: NeighborRule = {
 *   left: "road_straight",
 *   right: "road_turn",
 *   rightRotation: 1,
 * };
 * ```
 */
export interface NeighborRule {
  /** Tile name on the left (or top) side. */
  left: string;

  /**
   * Orientation index for the left tile.
   * @defaultValue `0`
   */
  leftRotation?: number;

  /** Tile name on the right (or bottom) side. */
  right: string;

  /**
   * Orientation index for the right tile.
   * @defaultValue `0`
   */
  rightRotation?: number;
}

/** Configuration for constructing a {@link SimpleTiledModel}. */
export interface SimpleTiledModelConfig {
  /** Tile definitions. Must contain at least one tile. */
  tiles: TileConfig[];

  /** Adjacency rules (left-right pairs). Must contain at least one rule. */
  neighbors: NeighborRule[];

  /** Output width in tile units. Must be positive. */
  width: number;

  /** Output height in tile units. Must be positive. */
  height: number;

  /**
   * Whether the output wraps at edges (toroidal topology).
   * @defaultValue `false`
   */
  periodic?: boolean;

  /**
   * Heuristic for cell selection during observation.
   * @defaultValue `Heuristic.Entropy`
   */
  heuristic?: Heuristic;

  /**
   * Pixel size of each tile (width = height = tileSize). Only required when
   * tile configs include pixel data for rendering.
   * @defaultValue `1`
   */
  tileSize?: number;

  /** Optional subset of tile names to use. Tiles not in this list are excluded. */
  subset?: string[];

  /**
   * Whether to apply a ground constraint: the last tile type is pinned to the
   * bottom row and forbidden elsewhere.
   * @defaultValue `false`
   */
  ground?: boolean;
}

/**
 * Configuration for constructing an {@link OverlappingModel}.
 *
 * @example
 * ```ts
 * const config: OverlappingModelConfig = {
 *   sample: pixels,        // Uint32Array from canvas getImageData
 *   sampleWidth: 64,
 *   sampleHeight: 64,
 *   N: 3,
 *   width: 48,
 *   height: 48,
 *   periodic: true,
 *   symmetry: 8,
 * };
 * ```
 */
export interface OverlappingModelConfig {
  /**
   * Input sample image as a flat row-major Uint32Array of RGBA pixels.
   * Length must equal `sampleWidth * sampleHeight`.
   */
  sample: Uint32Array;

  /** Width of the sample image in pixels. */
  sampleWidth: number;

  /** Height of the sample image in pixels. */
  sampleHeight: number;

  /**
   * Pattern size. Patterns are NxN pixel regions extracted from the sample.
   * @defaultValue `3`
   */
  N?: number;

  /** Output width in cells. Must be positive. */
  width: number;

  /** Output height in cells. Must be positive. */
  height: number;

  /**
   * Whether the sample image wraps at edges when extracting patterns.
   * @defaultValue `false`
   */
  periodicInput?: boolean;

  /**
   * Whether the output wraps at edges (toroidal topology).
   * @defaultValue `false`
   */
  periodic?: boolean;

  /**
   * Number of symmetry variants to extract per pattern position: 1, 2, 4, or 8.
   * Higher values produce more patterns and better coverage at a preprocessing cost.
   * @defaultValue `8`
   */
  symmetry?: number;

  /**
   * Whether to apply a ground constraint: the last extracted pattern is pinned
   * to the bottom row and forbidden elsewhere.
   * @defaultValue `false`
   */
  ground?: boolean;

  /**
   * Heuristic for cell selection during observation.
   * @defaultValue `Heuristic.Entropy`
   */
  heuristic?: Heuristic;
}

/**
 * Result returned by {@link Model.run}.
 *
 * On success, `observed` contains the collapsed tile/pattern index for every
 * cell. On failure (contradiction), `observed` may contain `-1` for
 * uncollapsed cells.
 */
export interface WFCResult {
  /** Whether generation completed without contradiction. */
  success: boolean;

  /**
   * Tile or pattern index at each cell (flat row-major, length = width * height).
   * A value of `-1` indicates an uncollapsed cell (only on failure).
   */
  observed: Int32Array;
}
