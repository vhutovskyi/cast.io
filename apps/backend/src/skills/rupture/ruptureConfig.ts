/**
 * Rupture's numbers, payloads and fan. Shared code: the frontend imports this
 * file too, so it must stay pure — no imports beyond shared constants and types.
 */
import { PLAYER_HALF } from "../../shared/constants.js";
import { lineBlocked, type Obstacle } from "../../shared/obstacles.js";

/**
 * Rupture (earth's ultimate): the caster tears the ground open ahead of them.
 * For `windupMs` the fan shows on the ground to the caster alone — enemies get
 * no warning — then a shockwave runs out from their feet across it — narrow at the caster,
 * wider with distance, cut off flat at its range — and every living enemy on
 * the ground the front reaches is struck once and stunned (`stunned`: no
 * walking, jumping or casting). Jumping over the front dodges it; a raised
 * wall shields whoever is behind it.
 */
export const RUPTURE = {
  /** To each body the front reaches. */
  damage: 15,
  /** How long each victim stays stunned. */
  stunMs: 2000,
  cooldownMs: 30_000,
  /** From the cast to the front setting off: the fan shows to the caster meanwhile. */
  windupMs: 500,
  /** How fast the front runs out from the caster, in simulation units per second: full range in ~0.29 s. */
  waveSpeed: 900,
  /** How far ahead the fan reaches, along the caster's facing, in simulation units: the flat far edge. */
  range: 260,
  /** How far the fan's sides open from the facing, in degrees: its width grows with distance. */
  halfAngleDeg: 30,
  /** Half the fan's width at the caster's feet, in simulation units: it starts narrow, not from a point. */
  baseHalfWidth: 8,
  /** A body whose feet are higher than this off the floor is above the front: a jump dodges it. */
  groundReach: 25,
} as const;

/** How long the front takes to run its full range (and past the bodies standing at its edge), in ms. */
export const RUPTURE_TRAVEL_MS = ((RUPTURE.range + PLAYER_HALF) / RUPTURE.waveSpeed) * 1000;

/** How far out the front has come `elapsedMs` after the cast: nowhere during the wind-up. */
export function ruptureFront(elapsedMs: number): number {
  return Math.max(0, elapsedMs - RUPTURE.windupMs) / 1000 * RUPTURE.waveSpeed;
}

const TAN_HALF_ANGLE = Math.tan((RUPTURE.halfAngleDeg * Math.PI) / 180);

/** Client → server: tear the ground open along this facing (radians, as in `MouseLook`). */
export interface RuptureAim { yaw: number; }

export interface RupturePoint { x: number; y: number; }

/** A body the front may reach: anyone in the room. */
export interface RuptureTarget extends RupturePoint { z: number; hp: number; }

/**
 * A point in the fan's own frame: `along` the facing from the origin, and
 * `across` it (positive to the right). Same convention as `stepEntity`: at
 * yaw 0 forward is -y and right is +x.
 */
export function ruptureLocal(origin: RupturePoint, yaw: number, point: RupturePoint) {
  const dx = point.x - origin.x;
  const dy = point.y - origin.y;
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  return { along: -dx * sin - dy * cos, across: dx * cos - dy * sin };
}

/** Back from the fan's frame to the floor's. */
export function ruptureWorld(origin: RupturePoint, yaw: number, along: number, across: number): RupturePoint {
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  return { x: origin.x - sin * along + cos * across, y: origin.y - cos * along - sin * across };
}

/** Half the fan's width `along` units out (clamped to the fan): it widens with the angle. */
export function ruptureHalfWidth(along: number) {
  return RUPTURE.baseHalfWidth + Math.max(0, Math.min(RUPTURE.range, along)) * TAN_HALF_ANGLE;
}

/**
 * Whether `point` is inside the fan from `origin` along `yaw` — or within
 * `slack` of it (a body's half-width), ahead of the origin all the same: on
 * or behind the caster's line is never in it.
 */
export function inRuptureFan(origin: RupturePoint, yaw: number, point: RupturePoint, slack = 0) {
  const { along, across } = ruptureLocal(origin, yaw, point);
  if (along < 0 || along - slack > RUPTURE.range) { return false; }
  return Math.abs(across) <= ruptureHalfWidth(along) + slack;
}

/**
 * The fan's four corners on the floor, in order round it: the narrow base's
 * left and right at the origin, then the far edge's right and left.
 */
export function ruptureCorners(origin: RupturePoint, yaw: number): RupturePoint[] {
  const base = ruptureHalfWidth(0);
  const far = ruptureHalfWidth(RUPTURE.range);
  return [
    ruptureWorld(origin, yaw, 0, -base),
    ruptureWorld(origin, yaw, 0, base),
    ruptureWorld(origin, yaw, RUPTURE.range, far),
    ruptureWorld(origin, yaw, RUPTURE.range, -far),
  ];
}

/** Whether a raised wall stands between the origin and `point`, low along the floor where the front runs. */
export function ruptureBlocked(origin: RupturePoint, point: RupturePoint, obstacles: Iterable<Obstacle>) {
  return lineBlocked({ x: origin.x, y: origin.y, z: 1 }, { x: point.x, y: point.y, z: 1 }, obstacles) !== null;
}

/**
 * The one hit rule, for one step of the front from `from` to `to` units out:
 * whether it reaches `body` — a living body inside the fan (with a body's
 * half-width of slack), on or near the floor, the front's stretch crossing
 * it, and no wall in between. The server runs it every step for each body
 * not yet struck; a body is only ever struck once.
 */
export function ruptureReaches(
  origin: RupturePoint,
  yaw: number,
  from: number,
  to: number,
  body: RuptureTarget,
  obstacles: Iterable<Obstacle> = [],
) {
  if (body.hp <= 0 || body.z > RUPTURE.groundReach) { return false; }
  if (!inRuptureFan(origin, yaw, body, PLAYER_HALF)) { return false; }
  const { along } = ruptureLocal(origin, yaw, body);
  // The front's stretch this step overlaps the body's, front to back.
  if (along - PLAYER_HALF > to || along + PLAYER_HALF < from) { return false; }
  return !ruptureBlocked(origin, body, obstacles);
}

/**
 * Server → everyone: accepted. The caster's next one is `cooldownMs` away,
 * and wave `id` runs out from `x, y` along `yaw`: every client runs the
 * front out at `RUPTURE.waveSpeed` itself. Who it strikes shows in their
 * synced `Player.effects` (`stunned`) and health — there is no hit message.
 */
export interface RuptureCast extends RupturePoint { id: number; casterId: string; cooldownMs: number; yaw: number; }
