import { ARENA_WIDTH, ARENA_HEIGHT, PLAYER_HALF, PLAYER_SPEED, GRAVITY, JUMP_SPEED, FLIGHT_RISE_SPEED } from "./constants.js";
import { FLAME_BREATH } from "../skills/flameBreath/flameBreathConfig.js";
import type { MoveLimits } from "../effects/effectConfig.js";
import { pushOutOfObstacles, type Obstacle } from "./obstacles.js";
import { FLAT, groundHeight, type Terrain } from "./terrain.js";

/**
 * Steepest ground you can walk up, as rise over run (1 = 45°). Anything
 * steeper stops you like a wall — unless you're already above it, mid-jump.
 */
export const MAX_WALK_SLOPE = 1;

/** Small ledges you step up without a jump, in units. */
const STEP_UP = 2;

/**
 * Walking downhill, how far the ground may drop under you in one step and
 * still hold you, in units, so you run down a slope instead of hopping off it.
 * Walking full speed down the steepest walkable slope drops ~9 units a step.
 */
const GROUND_SNAP = 12;

/** Within this of the ground counts as standing on it. */
const GROUND_EPSILON = 1e-3;

/**
 * Structural types on purpose: the same step runs on a server Schema instance
 * and on the client reconciler's plain predicted copy, with no schema runtime
 * involved in the simulation.
 */
export interface EntityState {
  x: number; y: number; z: number; vx: number; vy: number; vz: number; yaw: number;
  /** Forced slide: while `dashTime` (s) is left, the horizontal velocity is (`dashVx`, `dashVy`), whatever is pressed. */
  dashVx: number; dashVy: number; dashTime: number;
  /** Above 0: rise to this height and hover there, without gravity. */
  flightZ: number;
}
export interface MoveInputLike { moveX: number; moveY: number; yaw: number; jump: boolean; breath: boolean; }

const clamp = (value: number, min: number, max: number) =>
  (value < min ? min : value > max ? max : value);

/** No status effects: walk at full speed, jump freely. */
export const FREE_MOVEMENT: Readonly<MoveLimits> = { speedScale: 1, canJump: true };

/**
 * The single movement step, run identically by the server (once per received
 * input) and by the client reconciler (predict, then replay on rollback).
 * `limits` is what status effects allow (`moveLimits` of `Player.effects`);
 * `obstacles` are the walls standing (`state.walls`), which nobody walks through.
 * `terrain` is the map's ground: bodies stand on it, and slopes steeper than
 * `MAX_WALK_SLOPE` block like walls.
 *
 * Pure function of (state, input, dt, limits, obstacles, terrain): no clocks, no
 * randomness, no reads outside its arguments. That is the whole contract —
 * break it and the client's prediction drifts from the server every time.
 */
export function stepEntity(
  entity: EntityState,
  input: MoveInputLike,
  dt: number,
  limits: Readonly<MoveLimits>,
  obstacles: Iterable<Obstacle> = [],
  terrain: Terrain = FLAT,
): void {
  // Read before moving: only a body standing on the ground may jump or stick to a slope.
  const grounded = entity.z <= groundHeight(terrain, entity.x, entity.y) + GROUND_EPSILON;

  let moveX = input.moveX;
  let moveY = input.moveY;

  // Normalize the diagonal, so it isn't faster than a straight line.
  if (moveX !== 0 && moveY !== 0) {
    moveX *= Math.SQRT1_2;
    moveY *= Math.SQRT1_2;
  }

  // Rotate the local move by the look direction. The wire carries yaw as a
  // float32, so round here too: the client predicts with the exact value the
  // server will decode. At yaw 0 forward is -y, which renders as -z in 3D.
  const yaw = Math.fround(input.yaw);
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const dirX = moveX * cos + moveY * sin;
  const dirY = moveY * cos - moveX * sin;

  // Breathing fire slows you down. The server has already vetoed a breath it
  // won't allow, so the flag here is exactly the one the client predicted with.
  // Status effects (a slow, a freeze) slow you down on top of that.
  const speed = (input.breath ? PLAYER_SPEED * FLAME_BREATH.moveSpeedScale : PLAYER_SPEED) * limits.speedScale;
  let vx = dirX * speed;
  let vy = dirY * speed;

  // A forced slide (a leap, a knockback) overrides walking — and every slow:
  // it was set by the server, so the client replays exactly the same one.
  if (entity.dashTime > 0) {
    vx = entity.dashVx;
    vy = entity.dashVy;
    entity.dashTime = Math.max(0, entity.dashTime - dt);
  }

  const x = entity.x + vx * dt;
  const y = entity.y + vy * dt;

  // Raised walls first: slide along them, then stay inside the arena.
  const pushed = pushOutOfObstacles({ x, y, z: entity.z }, PLAYER_HALF, { vx, vy }, obstacles);
  vx = pushed.vx;
  vy = pushed.vy;
  const clampedX = clamp(pushed.x, PLAYER_HALF, ARENA_WIDTH - PLAYER_HALF);
  const clampedY = clamp(pushed.y, PLAYER_HALF, ARENA_HEIGHT - PLAYER_HALF);

  // Hitting the arena's edge also kills the velocity heading into it, so the
  // reconciler replays the same stop the server did.
  if (clampedX !== pushed.x) { vx = 0; }
  if (clampedY !== pushed.y) { vy = 0; }

  // Ground too steep to climb stops you like a wall: slide along it if one
  // axis is still climbable, else stay put. The allowance grows with the
  // distance covered, so a slope's steepness counts, not your speed.
  const climbable = (toX: number, toY: number) =>
    groundHeight(terrain, toX, toY) <= entity.z + Math.hypot(toX - entity.x, toY - entity.y) * MAX_WALK_SLOPE + STEP_UP;
  let nextX = clampedX;
  let nextY = clampedY;
  if (!climbable(nextX, nextY)) {
    if (climbable(nextX, entity.y)) {
      nextY = entity.y;
      vy = 0;
    } else if (climbable(entity.x, nextY)) {
      nextX = entity.x;
      vx = 0;
    } else {
      nextX = entity.x;
      nextY = entity.y;
      vx = 0;
      vy = 0;
    }
  }

  entity.x = nextX;
  entity.y = nextY;
  entity.vx = vx;
  entity.vy = vy;
  entity.yaw = yaw;

  // Flying: climb to the flight height at a steady rate, then hover there.
  if (entity.flightZ > 0) {
    const z = Math.min(entity.flightZ, entity.z + FLIGHT_RISE_SPEED * dt);
    entity.vz = z < entity.flightZ ? FLIGHT_RISE_SPEED : 0;
    entity.z = z;
    return;
  }

  // Vertical: take off only from the ground (no double jump), then integrate
  // gravity semi-implicitly and land exactly on the floor. Walking downhill
  // keeps you on the slope instead of hopping off it, step by step.
  const floor = groundHeight(terrain, entity.x, entity.y);
  let vz = grounded && input.jump && limits.canJump ? JUMP_SPEED : entity.vz;
  vz -= GRAVITY * dt;
  let z = entity.z + vz * dt;
  if (z <= floor || (grounded && vz <= 0 && z - floor <= GROUND_SNAP)) {
    z = floor;
    vz = 0;
  }

  entity.z = z;
  entity.vz = vz;
}

/** Stops any forced slide and flight: death, respawn, a fresh round. */
export function clearForcedMotion(entity: EntityState): void {
  entity.dashVx = 0;
  entity.dashVy = 0;
  entity.dashTime = 0;
  entity.flightZ = 0;
}

/**
 * What a dead player's step runs instead of their input: no walking, no
 * jumping, no breathing, same facing — gravity still applies, so a mid-air death falls.
 * The server substitutes it (never trust the wire); the client sends it too,
 * so prediction stays identical.
 */
export function deadInput(yaw: number): MoveInputLike {
  return { moveX: 0, moveY: 0, jump: false, breath: false, yaw };
}

/** Wraps any angle into [-π, π], the range the room's input sanitizer accepts. */
export function wrapAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}
