import { ARENA_WIDTH, ARENA_HEIGHT } from "./constants.js";

/**
 * The ground's shape: a heightmap over the whole arena. Shared code: the
 * server stands bodies on it, the client's prediction does the same, and the
 * scene draws and aims against it — one function, so they never disagree.
 *
 * `heights` is a row-major grid of `cols` × `rows` samples; sample (i, j)
 * sits at x = i · ARENA_WIDTH / (cols - 1), y = j · ARENA_HEIGHT / (rows - 1).
 * Between samples the ground is bilinear. A heightmap has no overhangs —
 * no bridges, no caves — which an arena doesn't need.
 */
export interface Terrain {
  readonly cols: number;
  readonly rows: number;
  readonly heights: readonly number[];
}

/** The open arena every map had before terrain: the floor at z = 0 everywhere. */
export const FLAT: Terrain = { cols: 2, rows: 2, heights: [0, 0, 0, 0] };

/** A smooth round mound (or, with a negative height, a dip) for `terrainFromHills`. */
export interface Hill {
  x: number;
  y: number;
  /** Where it has flattened out completely. */
  radius: number;
  /** At its centre. */
  height: number;
}

/** Spacing of the samples `terrainFromHills` takes, in simulation units. */
const HILL_SAMPLE_STEP = 10;

/**
 * A heightmap built from a list of hills, summed, floored at 0 so the ground
 * never sinks below the arena's base. Each hill is a cosine bump: flat at the
 * top, flat where it meets the floor, steepest halfway.
 */
export function terrainFromHills(hills: readonly Hill[]): Terrain {
  const cols = Math.round(ARENA_WIDTH / HILL_SAMPLE_STEP) + 1;
  const rows = Math.round(ARENA_HEIGHT / HILL_SAMPLE_STEP) + 1;
  const heights: number[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = (i * ARENA_WIDTH) / (cols - 1);
      const y = (j * ARENA_HEIGHT) / (rows - 1);
      let h = 0;
      for (const hill of hills) {
        const d = Math.hypot(x - hill.x, y - hill.y) / hill.radius;
        if (d < 1) { h += (hill.height * (1 + Math.cos(Math.PI * d))) / 2; }
      }
      heights.push(Math.max(0, h));
    }
  }
  return { cols, rows, heights };
}

const clamp = (value: number, min: number, max: number) =>
  (value < min ? min : value > max ? max : value);

/**
 * The floor's height under (x, y). Outside the arena it reads the nearest
 * edge, so a body clamped against the bounds stands on what it sees.
 * Pure: safe in `stepEntity`.
 */
export function groundHeight(terrain: Terrain, x: number, y: number): number {
  const { cols, rows, heights } = terrain;
  const gx = clamp((x / ARENA_WIDTH) * (cols - 1), 0, cols - 1);
  const gy = clamp((y / ARENA_HEIGHT) * (rows - 1), 0, rows - 1);
  const i = Math.min(Math.floor(gx), cols - 2);
  const j = Math.min(Math.floor(gy), rows - 2);
  const fx = gx - i;
  const fy = gy - j;
  const row = j * cols;
  const top = heights[row + i] * (1 - fx) + heights[row + i + 1] * fx;
  const bottom = heights[row + cols + i] * (1 - fx) + heights[row + cols + i + 1] * fx;
  return top * (1 - fy) + bottom * fy;
}

/** How far `raycastTerrain` moves per check, in simulation units: under a sample cell. */
const RAY_STEP = 4;

/**
 * Where a ray first meets the ground, or null if it doesn't within
 * `maxDistance` (or leaves the arena first). `dir` need not be normalised;
 * `maxDistance` is along it, in simulation units. Marches in short steps,
 * then bisects the step that crossed, so a hilltop can't be skipped.
 */
export function raycastTerrain(
  terrain: Terrain,
  from: { x: number; y: number; z: number },
  dir: { x: number; y: number; z: number },
  maxDistance: number,
): { x: number; y: number; z: number } | null {
  const length = Math.hypot(dir.x, dir.y, dir.z);
  if (length === 0) { return null; }
  const dx = dir.x / length;
  const dy = dir.y / length;
  const dz = dir.z / length;
  const above = (t: number) => from.z + dz * t - groundHeight(terrain, from.x + dx * t, from.y + dy * t);

  if (above(0) <= 0) { return { x: from.x, y: from.y, z: groundHeight(terrain, from.x, from.y) }; }

  let near = 0;
  for (let t = RAY_STEP; near < maxDistance; t += RAY_STEP) {
    const far = Math.min(t, maxDistance);
    const x = from.x + dx * far;
    const y = from.y + dy * far;
    if (x < 0 || x > ARENA_WIDTH || y < 0 || y > ARENA_HEIGHT) { return null; }
    if (above(far) <= 0) {
      let lo = near;
      let hi = far;
      for (let k = 0; k < 12; k++) {
        const mid = (lo + hi) / 2;
        if (above(mid) > 0) { lo = mid; } else { hi = mid; }
      }
      return { x: from.x + dx * hi, y: from.y + dy * hi, z: from.z + dz * hi };
    }
    near = far;
  }
  return null;
}
