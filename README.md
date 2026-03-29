# WaveFunctionCollapse

High-performance TypeScript implementation of the [Wave Function Collapse](https://github.com/mxgmn/WaveFunctionCollapse) algorithm for procedural generation.

<p align="center"><img alt="main collage" src="images/wfc.png"></p>
<p align="center"><img alt="main gif" src="images/wfc.gif"></p>

Zero dependencies. Pure ESM. Works with any JavaScript runtime (Node, Bun, Deno) and any bundler (Vite, webpack, esbuild).

## Install

```bash
npm install wavefunctioncollapse
```

Or add it directly from the repository:

```bash
npm install github:jimzenn/wavefunctioncollapse
```

## Quick Start

### Overlapping Model

Learns NxN patterns from a sample image and generates new images containing only those patterns.

```typescript
import { OverlappingModel } from "wavefunctioncollapse";

// sample: Uint32Array of RGBA pixels from your input image
// e.g. from a canvas: new Uint32Array(ctx.getImageData(0, 0, w, h).data.buffer)
const model = new OverlappingModel({
  sample: samplePixels,
  sampleWidth: 64,
  sampleHeight: 64,
  N: 3, // pattern size (3x3)
  width: 48, // output width in cells
  height: 48, // output height in cells
  periodic: true, // wrap output edges
  periodicInput: true, // wrap input edges when extracting patterns
  symmetry: 8, // extract rotations/reflections (1, 2, 4, or 8)
});

const result = model.run(42); // seed for reproducibility

if (result.success) {
  const pixels = model.renderToBuffer(result); // Uint32Array of RGBA pixels
  // Draw pixels to a canvas, save to file, etc.
}
```

### Simple Tiled Model

Uses pre-defined tiles with explicit adjacency rules. Ideal for tilemaps, dungeon generation, circuit layouts, etc.

```typescript
import { SimpleTiledModel } from "wavefunctioncollapse";

const model = new SimpleTiledModel({
  tiles: [
    { name: "grass", symmetry: "X", weight: 2 },
    { name: "road_straight", symmetry: "I", weight: 1 },
    { name: "road_turn", symmetry: "L", weight: 0.5 },
    { name: "water", symmetry: "X", weight: 1 },
  ],
  neighbors: [
    { left: "grass", right: "grass" },
    { left: "grass", right: "road_straight" },
    { left: "road_straight", right: "road_straight" },
    { left: "road_straight", right: "road_turn", rightRotation: 1 },
    { left: "grass", right: "water" },
    // ... more adjacency rules
  ],
  width: 20,
  height: 20,
  periodic: false,
});

const result = model.run(123);

if (result.success) {
  // Option 1: Get tile names per cell
  const grid = model.textOutput(result); // string[][] — grid[y][x] = "grass 0"

  // Option 2: Get pixel buffer (if you provided tile pixel data)
  const pixels = model.renderToBuffer(result);
}
```

## API Reference

### `OverlappingModel`

#### Constructor

```typescript
new OverlappingModel(config: OverlappingModelConfig)
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `sample` | `Uint32Array` | **required** | Input image as flat RGBA pixel array |
| `sampleWidth` | `number` | **required** | Width of the sample image |
| `sampleHeight` | `number` | **required** | Height of the sample image |
| `width` | `number` | **required** | Output width in cells |
| `height` | `number` | **required** | Output height in cells |
| `N` | `number` | `3` | Pattern size (NxN) |
| `periodic` | `boolean` | `false` | Whether output wraps at edges |
| `periodicInput` | `boolean` | `false` | Whether input wraps when extracting patterns |
| `symmetry` | `number` | `8` | Number of symmetry variants: 1, 2, 4, or 8 |
| `ground` | `boolean` | `false` | Pin last pattern to bottom row |
| `heuristic` | `Heuristic` | `Entropy` | Cell selection heuristic |

#### Methods

- **`run(seed: number, limit?: number): WFCResult`** — Run the algorithm. Returns `{ success, observed }`.
- **`renderToBuffer(result: WFCResult): Uint32Array`** — Render result to RGBA pixels.
- **`patternCount: number`** — Number of unique patterns extracted.

### `SimpleTiledModel`

#### Constructor

```typescript
new SimpleTiledModel(config: SimpleTiledModelConfig)
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `tiles` | `TileConfig[]` | **required** | Tile definitions |
| `neighbors` | `NeighborRule[]` | **required** | Adjacency rules (left-right pairs) |
| `width` | `number` | **required** | Output width in tiles |
| `height` | `number` | **required** | Output height in tiles |
| `periodic` | `boolean` | `false` | Whether output wraps at edges |
| `tileSize` | `number` | `1` | Pixel size of each tile (for rendering) |
| `subset` | `string[]` | all tiles | Optional subset of tile names to use |
| `ground` | `boolean` | `false` | Pin last tile type to bottom row |
| `heuristic` | `Heuristic` | `Entropy` | Cell selection heuristic |

#### Methods

- **`run(seed: number, limit?: number): WFCResult`** — Run the algorithm.
- **`renderToBuffer(result: WFCResult): Uint32Array`** — Render to RGBA pixels (requires tile pixel data).
- **`textOutput(result: WFCResult): string[][]`** — Get tile names as a 2D grid.
- **`tilenames: string[]`** — All tile variant names (e.g. `"road_turn 2"`).
- **`tiles: Uint32Array[]`** — Pixel data for each variant.

### `TileConfig`

```typescript
interface TileConfig {
  name: string;
  symmetry?: "X" | "I" | "T" | "L" | "\\" | "F"; // default "X"
  weight?: number; // default 1
  pixels?: Uint32Array | Uint32Array[]; // optional, for rendering
}
```

### `NeighborRule`

```typescript
interface NeighborRule {
  left: string; // tile name
  leftRotation?: number; // orientation index (default 0)
  right: string; // tile name
  rightRotation?: number; // orientation index (default 0)
}
```

### `Heuristic`

```typescript
import { Heuristic } from "wavefunctioncollapse";

Heuristic.Entropy  // Best quality (default)
Heuristic.MRV      // Minimum Remaining Values — fast, good quality
Heuristic.Scanline // Fastest, sequential left-to-right
```

### `WFCResult`

```typescript
interface WFCResult {
  success: boolean;
  observed: Int32Array; // tile/pattern index per cell, -1 if uncollapsed
}
```

## Tile Symmetry System

Each tile is assigned a symmetry type that determines how many orientation variants are generated:

<p align="center"><img alt="symmetries" src="images/symmetry-system.png"></p>

| Symmetry | Cardinality | Description |
|----------|-------------|-------------|
| `X` | 1 | Fully symmetric (e.g. grass, solid color) |
| `I` | 2 | 180-degree symmetry (e.g. straight road) |
| `T` | 4 | T-shaped symmetry |
| `L` | 4 | Corner / L-shaped |
| `\\` | 2 | Diagonal symmetry |
| `F` | 8 | Fully asymmetric (all 8 orientations distinct) |

Adjacency rules are automatically expanded across all orientations using the symmetry system, so you only need to specify canonical neighbor pairs.

## Performance

Optimized with flat TypedArrays throughout (no object allocations in the hot loop):

- `Uint8Array` wave state
- `Int32Array` compatible counts + propagation stack
- `Float64Array` entropy accumulators
- Seeded xoshiro128** PRNG (fast + reproducible)

Typical benchmarks (Node.js, single thread):

| Model | Grid | Patterns/Tiles | Time |
|-------|------|----------------|------|
| Overlapping | 48x48 | 7 | ~2ms |
| Simple Tiled | 30x30 | 20 | ~4ms |

## Algorithm

The Wave Function Collapse algorithm works by:

1. **Initialize** — every cell starts in superposition (all patterns/tiles possible).
2. **Observe** — find the cell with lowest Shannon entropy and collapse it to a single state, weighted by pattern frequency.
3. **Propagate** — remove patterns that are no longer compatible with neighbors (constraint propagation using AC-4).
4. **Repeat** steps 2-3 until all cells are collapsed (success) or a contradiction is reached (failure).

<p align="center"><img alt="local similarity" src="images/patterns.png"></p>

## Building from Source

```bash
npm install
npm run build
```

Output goes to `dist/` (ESM + declaration files + source maps).

## Credits

Original algorithm and C# implementation by [Maxim Gumin](https://github.com/mxgmn).

TypeScript port optimized for high-performance generation in JavaScript runtimes.

## License

MIT
