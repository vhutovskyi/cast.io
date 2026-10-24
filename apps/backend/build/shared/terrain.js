import { ARENA_WIDTH, ARENA_HEIGHT } from "./constants.js";
/** The open arena every map had before terrain: the floor at z = 0 everywhere. */
export const FLAT = { cols: 2, rows: 2, heights: [0, 0, 0, 0] };
/** Spacing of the samples `terrainFromHills` takes, in simulation units. */
const HILL_SAMPLE_STEP = 10;
/**
 * A heightmap built from a list of hills, summed, floored at 0 so the ground
 * never sinks below the arena's base. Each hill is a cosine bump: flat at the
 * top, flat where it meets the floor, steepest halfway.
 */
export function terrainFromHills(hills) {
    const cols = Math.round(ARENA_WIDTH / HILL_SAMPLE_STEP) + 1;
    const rows = Math.round(ARENA_HEIGHT / HILL_SAMPLE_STEP) + 1;
    const heights = [];
    for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
            const x = (i * ARENA_WIDTH) / (cols - 1);
            const y = (j * ARENA_HEIGHT) / (rows - 1);
            let h = 0;
            for (const hill of hills) {
                const d = Math.hypot(x - hill.x, y - hill.y) / hill.radius;
                if (d < 1) {
                    h += (hill.height * (1 + Math.cos(Math.PI * d))) / 2;
                }
            }
            heights.push(Math.max(0, h));
        }
    }
    return { cols, rows, heights };
}
const clamp = (value, min, max) => (value < min ? min : value > max ? max : value);
/**
 * The floor's height under (x, y). Outside the arena it reads the nearest
 * edge, so a body clamped against the bounds stands on what it sees.
 * Pure: safe in `stepEntity`.
 */
export function groundHeight(terrain, x, y) {
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
export function raycastTerrain(terrain, from, dir, maxDistance) {
    const length = Math.hypot(dir.x, dir.y, dir.z);
    if (length === 0) {
        return null;
    }
    const dx = dir.x / length;
    const dy = dir.y / length;
    const dz = dir.z / length;
    const above = (t) => from.z + dz * t - groundHeight(terrain, from.x + dx * t, from.y + dy * t);
    if (above(0) <= 0) {
        return { x: from.x, y: from.y, z: groundHeight(terrain, from.x, from.y) };
    }
    let near = 0;
    for (let t = RAY_STEP; near < maxDistance; t += RAY_STEP) {
        const far = Math.min(t, maxDistance);
        const x = from.x + dx * far;
        const y = from.y + dy * far;
        if (x < 0 || x > ARENA_WIDTH || y < 0 || y > ARENA_HEIGHT) {
            return null;
        }
        if (above(far) <= 0) {
            let lo = near;
            let hi = far;
            for (let k = 0; k < 12; k++) {
                const mid = (lo + hi) / 2;
                if (above(mid) > 0) {
                    lo = mid;
                }
                else {
                    hi = mid;
                }
            }
            return { x: from.x + dx * hi, y: from.y + dy * hi, z: from.z + dz * hi };
        }
        near = far;
    }
    return null;
}
