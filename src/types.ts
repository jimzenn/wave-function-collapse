// Copyright (C) 2016 Maxim Gumin, The MIT License (MIT)
// TypeScript port

/** Heuristic for selecting the next cell to collapse. */
export const enum Heuristic {
  /** Shannon entropy — best quality, slightly slower. */
  Entropy = 0,
  /** Minimum Remaining Values — fast, good quality. */
  MRV = 1,
  /** Left-to-right, top-to-bottom — fastest, lowest quality. */
  Scanline = 2,
}

/** Tile symmetry type for SimpleTiledModel. */
export type TileSymmetry = "X" | "I" | "T" | "L" | "\\" | "F";

/** A tile definition for SimpleTiledModel. */
export interface TileConfig {
  /** Unique name for this tile. */
  name: string;
  /** Symmetry type (default "X"). */
  symmetry?: TileSymmetry;
  /** Relative weight / frequency (default 1). */
  weight?: number;
  /**
   * Pixel data for each orientation.
   * - If provided as a single Uint32Array, rotations/reflections are computed automatically.
   * - If provided as an array, each entry is a pre-rotated variant (length must match cardinality).
   */
  pixels?: Uint32Array | Uint32Array[];
}

/** A neighbor (adjacency) rule for SimpleTiledModel. */
export interface NeighborRule {
  /** Tile name for the left/top side. */
  left: string;
  /** Orientation index for left tile (default 0). */
  leftRotation?: number;
  /** Tile name for the right/bottom side. */
  right: string;
  /** Orientation index for right tile (default 0). */
  rightRotation?: number;
}

/** Configuration for SimpleTiledModel. */
export interface SimpleTiledModelConfig {
  /** Tile definitions. */
  tiles: TileConfig[];
  /** Adjacency rules (left–right pairs). */
  neighbors: NeighborRule[];
  /** Output width in tiles. */
  width: number;
  /** Output height in tiles. */
  height: number;
  /** Whether the output wraps around edges (default false). */
  periodic?: boolean;
  /** Heuristic for cell selection (default Entropy). */
  heuristic?: Heuristic;
  /** Tile pixel size — only needed if you provide tile pixel data (default 1). */
  tileSize?: number;
  /** Optional subset of tile names to use. */
  subset?: string[];
  /** Whether to use a ground constraint — last tile pinned to bottom row (default false). */
  ground?: boolean;
}

/** Configuration for OverlappingModel. */
export interface OverlappingModelConfig {
  /**
   * Input sample image as a flat Uint32Array of RGBA pixels.
   * Layout: [row0_col0, row0_col1, ..., row0_colW-1, row1_col0, ...] (row-major).
   */
  sample: Uint32Array;
  /** Width of the sample image in pixels. */
  sampleWidth: number;
  /** Height of the sample image in pixels. */
  sampleHeight: number;
  /** Pattern size N (default 3). Patterns are NxN. */
  N?: number;
  /** Output width in cells. */
  width: number;
  /** Output height in cells. */
  height: number;
  /** Whether the input sample wraps (default false). */
  periodicInput?: boolean;
  /** Whether the output wraps (default false). */
  periodic?: boolean;
  /** Number of symmetry variants to extract: 1, 2, 4, or 8 (default 8). */
  symmetry?: number;
  /** Whether to pin the last pattern to the bottom row (default false). */
  ground?: boolean;
  /** Heuristic for cell selection (default Entropy). */
  heuristic?: Heuristic;
}

/** Result from a successful generation run. */
export interface WFCResult {
  /** Whether generation succeeded (no contradiction). */
  success: boolean;
  /** The observed tile/pattern index at each cell (length = width * height). -1 if not collapsed. */
  observed: Int32Array;
}
