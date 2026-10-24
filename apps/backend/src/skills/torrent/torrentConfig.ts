/**
 * Torrent's numbers and payloads. Shared code: the frontend imports this
 * file too, so it must stay pure — no imports beyond shared constants and types.
 */
import { ARENA_WIDTH, ARENA_HEIGHT, PLAYER_HALF } from "../../shared/constants.js";

/**
 * Torrent (water), after Kunkka's: target a point on the ground within range;
 * after a delay a geyser of water and icicles erupts there, hurting every
 * *other* player inside it, hurling them into the air and slowing them
 * (`slow`, through `ABILITY_EFFECTS`). Only the caster sees it bubbling —
 * enemies learn of it when it erupts.
 */
export const TORRENT = {
  delayMs: 500,
  damage: 12,
  cooldownMs: 8000,
  /** How far from the caster it can be cast, along the floor. */
  range: 350,
  /** A little under two player-widths, in simulation units. */
  radius: PLAYER_HALF * 3.5,
  /** Upward speed it hurls its victims with: about 1.8 bodies high, ~0.9 s in the air. */
  launchSpeed: 330,
} as const;

export interface GroundPoint { x: number; y: number; }

/** Client → server: cast at a point on the ground plane. */
export interface TorrentCast extends GroundPoint {}

/** Server → caster only: accepted, bubbling until `delayMs` from now. */
export interface TorrentCharging extends GroundPoint { id: number; delayMs: number; cooldownMs: number; }

/** Server → everyone: the torrent erupted; `hits` were caught in it. */
export interface TorrentHit extends GroundPoint { id: number; hits: string[]; }

/**
 * Where a cast at `target` from `origin` really goes: pulled in along the
 * line to within range, and inside the arena. The server casts there and the
 * caster's client previews the same spot.
 */
export function clampTorrentTarget(origin: GroundPoint, target: GroundPoint): GroundPoint {
  let dx = target.x - origin.x;
  let dy = target.y - origin.y;
  const distance = Math.hypot(dx, dy);
  if (distance > TORRENT.range) {
    dx *= TORRENT.range / distance;
    dy *= TORRENT.range / distance;
  }
  return {
    x: Math.min(ARENA_WIDTH, Math.max(0, origin.x + dx)),
    y: Math.min(ARENA_HEIGHT, Math.max(0, origin.y + dy)),
  };
}
