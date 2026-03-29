/**
 * Wave Function Collapse — high-performance procedural generation library.
 *
 * Provides two model types:
 * - {@link OverlappingModel}: learns patterns from a sample image.
 * - {@link SimpleTiledModel}: uses explicit tile adjacency rules.
 *
 * Both models share the same {@link Model.run} interface and return a
 * {@link WFCResult} that can be rendered to pixels or mapped to tile names.
 *
 * @example
 * ```ts
 * import { OverlappingModel, SimpleTiledModel, Heuristic } from "wave-function-collapse";
 * ```
 *
 * @packageDocumentation
 * @license MIT
 * @copyright 2016 Maxim Gumin
 */

export { OverlappingModel } from "./overlapping.js";
export { SimpleTiledModel } from "./simple-tiled.js";
export { Model } from "./model.js";
export { Heuristic } from "./types.js";
export type {
  OverlappingModelConfig,
  SimpleTiledModelConfig,
  TileConfig,
  TileSymmetry,
  NeighborRule,
  WFCResult,
} from "./types.js";
