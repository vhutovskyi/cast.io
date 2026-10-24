/**
 * Twin Dragons' numbers, payloads and path. Shared code: the frontend imports
 * this file too, so it must stay pure — no imports beyond shared constants and types.
 */
import { ARENA_WIDTH, ARENA_HEIGHT, PLAYER_HALF } from "../../shared/constants.js";

/**
 * Twin Dragons (fire's ultimate): target a ground point in range; two streams
 * of fire leave the caster, one curving out to the left and one to the right,
 * and meet there. A stream's head hits whoever it touches (once per stream),
 * and the fire it leaves on the ground keeps burning anyone who steps in it for
 * a while; where they meet they blow up, damaging everyone in the blast. Every
 * hit adds Burn. Only the caster knows where the streams will meet — everyone
 * else sees the heads as they come — and a stream can be jumped over.
 */
export const TWIN_DRAGONS = {
  /** Farthest target from the caster, in simulation units: half the arena. */
  range: 400,
  /** From cast to the streams meeting. */
  travelMs: 1000,
  cooldownMs: 35_000,
  /** The blast where the streams meet. */
  damage: 25,
  /** A stream's head touching you, at most once per stream per cast. */
  streamDamage: 10,
  /** Blast radius around the meeting point. */
  blastRadius: PLAYER_HALF * 3,
  /** A stream's head hits bodies within this of its centre line; so wide is the fire it leaves. */
  streamRadius: 14,
  /** How long the fire a head leaves on the ground burns whoever steps in it. */
  trailMs: 3000,
  /** Flames hug the ground: feet higher than this jump over a stream. */
  streamHeight: 20,
  /** How far each stream bows out to its side, as a fraction of the distance to the target. */
  bow: 0.45,
} as const;

/** The two streams: -1 curves out to the caster's left, +1 to the right. */
export const TWIN_DRAGONS_SIDES = [-1, 1] as const;
export type TwinDragonsSide = (typeof TWIN_DRAGONS_SIDES)[number];

export interface GroundPoint { x: number; y: number; }

/** Client → server: cast at a point on the ground plane. */
export interface TwinDragonsCast { x: number; y: number; }

/**
 * Server → caster only: accepted, meeting at `target` in `travelMs`; their next
 * one is `cooldownMs` away. Nobody else is told where the streams are going.
 */
export interface TwinDragonsLaunch {
  id: number;
  origin: GroundPoint;
  target: GroundPoint;
  travelMs: number;
  cooldownMs: number;
}

/**
 * Server → everyone, every step while the streams fly: where each head is
 * `elapsedMs` into the flight, in `TWIN_DRAGONS_SIDES` order. Clients draw the
 * heads and the fire left behind them from these alone, played back on the
 * flight's own clock so uneven arrival doesn't show.
 */
export interface TwinDragonsHeads { id: number; elapsedMs: number; heads: GroundPoint[]; }

/** Server → everyone: the streams met and blew up here. */
export interface TwinDragonsBlast { id: number; x: number; y: number; hits: string[]; }

/**
 * The one targeting rule, run by the server for the real cast and by the
 * caster's client for the preview: no farther than `range` from the caster
 * (pulled back along the same direction), never outside the arena.
 */
export function clampTwinDragonsTarget(origin: GroundPoint, target: GroundPoint): GroundPoint {
  let dx = target.x - origin.x;
  let dy = target.y - origin.y;
  const distance = Math.hypot(dx, dy);
  if (distance > TWIN_DRAGONS.range) {
    dx *= TWIN_DRAGONS.range / distance;
    dy *= TWIN_DRAGONS.range / distance;
  }
  return {
    x: Math.min(ARENA_WIDTH, Math.max(0, origin.x + dx)),
    y: Math.min(ARENA_HEIGHT, Math.max(0, origin.y + dy)),
  };
}

/**
 * Where a stream's head is at `t` (0 = leaving the caster, 1 = meeting): a
 * quadratic curve bowed out to its side of the straight line. The server
 * flies the heads along it; the caster's client previews it.
 */
export function twinDragonsPoint(origin: GroundPoint, target: GroundPoint, side: TwinDragonsSide, t: number): GroundPoint {
  const dx = target.x - origin.x;
  const dy = target.y - origin.y;
  // Facing the target, the right-hand normal of (dx, dy) is (-dy, dx) in this
  // coordinate system (forward is -y at yaw 0, right is +x).
  const controlX = origin.x + dx / 2 - dy * side * TWIN_DRAGONS.bow;
  const controlY = origin.y + dy / 2 + dx * side * TWIN_DRAGONS.bow;
  const u = 1 - t;
  return {
    x: u * u * origin.x + 2 * u * t * controlX + t * t * target.x,
    y: u * u * origin.y + 2 * u * t * controlY + t * t * target.y,
  };
}
