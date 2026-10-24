/**
 * Obstacles raised in the arena (an earth wall, …): upright boxes, turned to
 * any angle on the floor. They block walking — in `stepEntity`, so the
 * client's prediction collides exactly as the server does — and projectiles
 * and lines of sight, through the helpers here. Shared code: pure, no imports
 * beyond types; the frontend imports this file too.
 */

/**
 * One obstacle: centred on (`x`, `y`) on the floor, `halfLength` along its
 * `angle` (radians; 0 runs along +x), `halfThickness` across it, `height` up
 * from the floor. Structural, so a synced `Wall` schema instance fits.
 */
export interface Obstacle {
  x: number;
  y: number;
  angle: number;
  halfLength: number;
  halfThickness: number;
  height: number;
}

export interface ObstaclePoint { x: number; y: number; z: number; }

/** A point in the obstacle's own frame: `u` along its length, `v` across it. */
function toLocal(o: Obstacle, x: number, y: number) {
  const dx = x - o.x;
  const dy = y - o.y;
  const cos = Math.cos(o.angle);
  const sin = Math.sin(o.angle);
  return { u: dx * cos + dy * sin, v: -dx * sin + dy * cos };
}

/** Back from the obstacle's frame to the floor's. */
function fromLocal(o: Obstacle, u: number, v: number) {
  const cos = Math.cos(o.angle);
  const sin = Math.sin(o.angle);
  return { x: o.x + u * cos - v * sin, y: o.y + u * sin + v * cos };
}

/** Whether a ball of `radius` at `p` touches the obstacle. */
export function touchesObstacle(p: ObstaclePoint, radius: number, o: Obstacle): boolean {
  if (p.z - radius >= o.height) { return false; }
  const { u, v } = toLocal(o, p.x, p.y);
  return Math.abs(u) <= o.halfLength + radius && Math.abs(v) <= o.halfThickness + radius;
}

/** The first obstacle a ball of `radius` at `p` touches, if any: where a projectile stops. */
export function obstacleAt(p: ObstaclePoint, radius: number, obstacles: Iterable<Obstacle>): Obstacle | undefined {
  for (const o of obstacles) {
    if (touchesObstacle(p, radius, o)) { return o; }
  }
  return undefined;
}

/**
 * Pushes a body of `radius` (an upright cylinder from `z`) out of every
 * obstacle it overlaps — unless it is above it — onto the nearest face, and
 * returns the velocity left once the part heading into those faces is taken
 * away, so a body walking into a wall slides along it. Pure, for `stepEntity`.
 */
export function pushOutOfObstacles(
  body: { x: number; y: number; z: number },
  radius: number,
  velocity: { vx: number; vy: number },
  obstacles: Iterable<Obstacle>,
): { x: number; y: number; vx: number; vy: number } {
  let { x, y } = body;
  let { vx, vy } = velocity;
  for (const o of obstacles) {
    if (body.z >= o.height) { continue; }
    const { u, v } = toLocal(o, x, y);
    // The nearest point of the obstacle's footprint to the body's centre.
    const nearU = Math.max(-o.halfLength, Math.min(o.halfLength, u));
    const nearV = Math.max(-o.halfThickness, Math.min(o.halfThickness, v));
    let normalU: number;
    let normalV: number;
    let pushU: number;
    let pushV: number;

    if (nearU === u && nearV === v) {
      // Centre inside: out through the nearest face.
      const outU = o.halfLength - Math.abs(u);
      const outV = o.halfThickness - Math.abs(v);
      if (outV <= outU) {
        normalU = 0;
        normalV = v < 0 ? -1 : 1;
        pushU = u;
        pushV = normalV * (o.halfThickness + radius);
      } else {
        normalU = u < 0 ? -1 : 1;
        normalV = 0;
        pushU = normalU * (o.halfLength + radius);
        pushV = v;
      }
    } else {
      const gapU = u - nearU;
      const gapV = v - nearV;
      const gap = Math.hypot(gapU, gapV);
      if (gap >= radius) { continue; }
      normalU = gapU / gap;
      normalV = gapV / gap;
      pushU = nearU + normalU * radius;
      pushV = nearV + normalV * radius;
    }

    ({ x, y } = fromLocal(o, pushU, pushV));
    // Take away the part of the velocity heading into the face.
    const cos = Math.cos(o.angle);
    const sin = Math.sin(o.angle);
    const normalX = normalU * cos - normalV * sin;
    const normalY = normalU * sin + normalV * cos;
    const into = vx * normalX + vy * normalY;
    if (into < 0) {
      vx -= into * normalX;
      vy -= into * normalY;
    }
  }
  return { x, y, vx, vy };
}

/**
 * Where the straight line from `a` to `b` first enters an obstacle, as a
 * fraction of the way (0..1) — or null if nothing stands in the way. The
 * line's height is followed too: it passes over an obstacle lower than it is
 * there. For lines of sight: a lash, a breath of fire.
 */
export function lineBlocked(a: ObstaclePoint, b: ObstaclePoint, obstacles: Iterable<Obstacle>): number | null {
  let first: number | null = null;
  for (const o of obstacles) {
    const from = toLocal(o, a.x, a.y);
    const to = toLocal(o, b.x, b.y);
    // Slab test: the stretch of the line inside the footprint on both axes.
    let enter = 0;
    let exit = 1;
    for (const [start, end, half] of [[from.u, to.u, o.halfLength], [from.v, to.v, o.halfThickness]] as const) {
      const delta = end - start;
      if (Math.abs(delta) < 1e-9) {
        if (Math.abs(start) > half) { enter = 1; exit = 0; }
        continue;
      }
      const t1 = (-half - start) / delta;
      const t2 = (half - start) / delta;
      enter = Math.max(enter, Math.min(t1, t2));
      exit = Math.min(exit, Math.max(t1, t2));
    }
    if (enter > exit) { continue; }
    // Over the top? Only if the line is above it the whole way through.
    const zIn = a.z + (b.z - a.z) * enter;
    const zOut = a.z + (b.z - a.z) * exit;
    if (Math.min(zIn, zOut) >= o.height) { continue; }
    if (first === null || enter < first) { first = enter; }
  }
  return first;
}
