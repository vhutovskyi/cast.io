/**
 * Boulders' numbers, payloads and rules. Shared code: the frontend imports
 * this file too, so it must stay pure — no imports beyond shared constants and types.
 */
import { ARENA_WIDTH, ARENA_HEIGHT, PLAYER_HALF, PLAYER_HEIGHT } from "../../shared/constants.js";
import type { Obstacle } from "../../shared/obstacles.js";

/**
 * Boulders (earth): raise a boulder out of the floor just ahead of you — up
 * to `maxStanding` at once. Each stays where it rose: a narrow block of rock
 * that stops players and projectiles like a wall, while you go about your
 * business. Near one of yours, use the skill again or click to kick it: it
 * flies off level along your facing and strikes the first living enemy it
 * touches, or breaks on a wall. Left alone, it crumbles after `lifetimeMs`.
 */
export const BOULDERS = {
  /** Yours standing at once, at most. */
  maxStanding: 3,
  /** Shortest time between two raises. */
  raiseIntervalMs: 1500,
  /** How long one stands if never kicked. */
  lifetimeMs: 15_000,
  /** Where it rises: its centre this far ahead of yours, along your facing. */
  raiseAhead: 44,
  /** About one body wide, a little less deep, half a body taller than anyone jumps their feet. */
  halfWidth: PLAYER_HALF,
  halfDepth: PLAYER_HALF * 0.75,
  height: 50,
  /**
   * You can kick one whose footprint your body is this close to (edge to edge):
   * near it, not touching. Raising one leaves you 23 away, so you can kick it
   * where you stand, without stepping up to it.
   */
  kickReach: 32,
  /** The server allows a little more: you see yourself a little ahead of where it has you. */
  kickSlack: 8,
  /** To the one player a kicked boulder strikes. */
  damage: 20,
  /** Kicked: how fast it flies, how big it is, at what height it flies, and when it gives up. */
  speed: 800,
  radius: PLAYER_HALF,
  flyHeight: 20,
  flyLifetimeMs: 2000,
} as const;

export interface BoulderPoint { x: number; y: number; z: number; }

/** A body a kicked boulder may strike: anyone in the room. */
export interface BoulderTarget extends BoulderPoint { hp: number; }

/** Client → server: kick the boulder you stand at along this facing (radians, as in `MouseLook`). */
export interface BoulderKick { yaw: number; }

/** Server → caster only: boulder `id` rose; the next may rise `raiseIntervalMs` from now. */
export interface BoulderRaised { id: string; raiseIntervalMs: number; }

/** Where a kicked boulder starts (simulation units) and its velocity (units per second). */
export interface BoulderLaunch { x: number; y: number; z: number; vx: number; vy: number; }

/** Server → everyone: boulder `id` (as it stood in `state.walls`) was kicked: every client flies it from this launch. */
export interface BoulderKicked extends BoulderLaunch { id: string; casterId: string; }

/** Server → everyone: kicked boulder `id` broke here — on `hitId` (struck), or on a wall. */
export interface BoulderHit { id: string; x: number; y: number; z: number; hitId?: string; }

/**
 * Where a boulder raised by someone at `at` facing `yaw` stands: just ahead
 * along their facing, square to it, inside the arena. Same convention as
 * `stepEntity`: at yaw 0 forward is -y.
 */
export function placeBoulder(at: { x: number; y: number }, yaw: number): Obstacle {
  const forwardX = -Math.sin(yaw);
  const forwardY = -Math.cos(yaw);
  const margin = BOULDERS.halfWidth;
  return {
    x: Math.min(ARENA_WIDTH - margin, Math.max(margin, at.x + forwardX * BOULDERS.raiseAhead)),
    y: Math.min(ARENA_HEIGHT - margin, Math.max(margin, at.y + forwardY * BOULDERS.raiseAhead)),
    // Its width runs across the facing.
    angle: Math.atan2(forwardY, forwardX) + Math.PI / 2,
    halfLength: BOULDERS.halfWidth,
    halfThickness: BOULDERS.halfDepth,
    height: BOULDERS.height,
  };
}

/** How far a body standing at `p` is from a boulder's footprint, edge to edge; 0 touching it. */
export function distanceToBoulder(boulder: Obstacle, p: { x: number; y: number }): number {
  const dx = p.x - boulder.x;
  const dy = p.y - boulder.y;
  const cos = Math.cos(boulder.angle);
  const sin = Math.sin(boulder.angle);
  const u = Math.abs(dx * cos + dy * sin) - boulder.halfLength;
  const v = Math.abs(-dx * sin + dy * cos) - boulder.halfThickness;
  return Math.max(0, Math.hypot(Math.max(0, u), Math.max(0, v)) - PLAYER_HALF);
}

/** Kicked from where it stood, level along the kicker's facing. Both server and clients fly it from this. */
export function kickBoulder(boulder: Obstacle, yaw: number): BoulderLaunch {
  return {
    x: boulder.x,
    y: boulder.y,
    z: BOULDERS.flyHeight,
    vx: -Math.sin(yaw) * BOULDERS.speed,
    vy: -Math.cos(yaw) * BOULDERS.speed,
  };
}

/** Where a kicked boulder is `t` seconds after the kick: a straight line. */
export function boulderPosition(launch: BoulderLaunch, t: number): BoulderPoint {
  return { x: launch.x + launch.vx * t, y: launch.y + launch.vy * t, z: launch.z };
}

/** If a kicked boulder here touches an arena wall, where it breaks — against it; otherwise null. */
export function boulderArenaHit(p: BoulderPoint): BoulderPoint | null {
  const r = BOULDERS.radius;
  if (p.x >= r && p.x <= ARENA_WIDTH - r && p.y >= r && p.y <= ARENA_HEIGHT - r) { return null; }
  return { x: Math.min(ARENA_WIDTH - r, Math.max(r, p.x)), y: Math.min(ARENA_HEIGHT - r, Math.max(r, p.y)), z: p.z };
}

/**
 * The one hit rule: the living body other than the kicker's that a kicked
 * boulder here touches — the closest, should it graze two at once — or undefined.
 */
export function boulderStruck(kickerId: string, at: BoulderPoint, players: Iterable<[string, BoulderTarget]>): string | undefined {
  let best: { id: string; distance: number } | undefined;
  for (const [id, player] of players) {
    if (id === kickerId || player.hp <= 0) { continue; }
    const across = Math.max(0, Math.hypot(player.x - at.x, player.y - at.y) - PLAYER_HALF);
    const up = Math.max(0, player.z - at.z, at.z - (player.z + PLAYER_HEIGHT));
    const distance = Math.hypot(across, up);
    if (distance > BOULDERS.radius) { continue; }
    if (!best || distance < best.distance) { best = { id, distance }; }
  }
  return best?.id;
}
