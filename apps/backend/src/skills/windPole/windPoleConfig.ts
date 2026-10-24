/**
 * Wind Pole's numbers, payloads, hit rules and path. Shared code: the
 * frontend imports this file too, so it must stay pure — no imports beyond
 * shared constants and types.
 */
import { ARENA_WIDTH, ARENA_HEIGHT, EYE_HEIGHT, PITCH_LIMIT, PLAYER_HALF, PLAYER_HEIGHT } from "../../shared/constants.js";
import { lineBlocked, type Obstacle } from "../../shared/obstacles.js";

/**
 * Wind Pole (wind's main skill): the wind mage swings their staff. An enemy
 * right in front of them, within the pole's reach, takes the blow itself —
 * the nearest one, alone. With no one that close, the same swing throws a
 * gust of wind along the view instead: it flies straight, strikes the first
 * living enemy it touches, alone, and breaks on a wall or the floor — or
 * dies out at the end of its range.
 */
export const WIND_POLE = {
  /** The pole's own blow, to the one enemy in reach. */
  meleeDamage: 6,
  /** The thrown gust, to the one enemy it strikes. */
  blastDamage: 8,
  cooldownMs: 600,
  /** How far the pole reaches, from the caster's centre to a body's edge, along the floor: about a body and a half. */
  meleeReach: 30,
  /** Sideways: how far off the facing a body's centre may be and still take the blow. */
  meleeHalfAngleDeg: 50,
  /** Up and down: how far apart two pairs of feet may be for the bodies to overlap in height. */
  meleeVerticalReach: PLAYER_HEIGHT,
  /** Gust speed, in simulation units per second: straight, it never slows or drops. */
  speed: 900,
  /** How far a gust flies before it dies out, in simulation units: about half the arena. */
  range: 420,
  /** Hit radius around the gust, in simulation units: what it breaks on touching. */
  radius: 7,
  /** Launch point: this far to the caster's right of their eyes — the swing's end. */
  handOffset: 10,
} as const;

/** How long a gust flies before dying out, in seconds: its range at its speed. */
export const WIND_BLAST_LIFETIME_S = WIND_POLE.range / WIND_POLE.speed;

/**
 * Longest step along a gust's path, in seconds, that can't carry it further
 * than its own radius — so it never skips through a body or a wall.
 */
export const WIND_BLAST_STEP_S = WIND_POLE.radius / WIND_POLE.speed;

/** Client → server: swing along the camera direction (radians, as in `MouseLook`). */
export interface WindPoleAim { yaw: number; pitch: number; }

/** Where a gust leaves the pole (simulation units) and its velocity (units per second). */
export interface WindBlastLaunch { x: number; y: number; z: number; vx: number; vy: number; vz: number; }

export interface WindPolePoint { x: number; y: number; z: number; }

/** A body the pole or a gust may strike: anyone in the room. */
export interface WindPoleTarget extends WindPolePoint { hp: number; }

/** The pole's blow: who takes it, and where on their body it lands. */
export interface WindPoleStrike extends WindPolePoint { hitId: string; }

const COS_HALF_ANGLE = Math.cos((WIND_POLE.meleeHalfAngleDeg * Math.PI) / 180);
/** A body right on top of the caster has no direction: it is in front. */
const EPSILON = 1e-6;
/** Where the pole lands on a body, and swings from on the caster: chest height. */
const CHEST = PLAYER_HEIGHT * 0.6;

/**
 * The melee rule: the nearest living body other than the caster's within
 * the pole's reach, inside the cone along the facing, overlapping the
 * caster's in height and not behind a wall — or null, and the swing throws
 * a gust instead. Same convention as `stepEntity`: at yaw 0 forward is -y.
 * The pitch plays no part: the pole sweeps a whole body's height. The server
 * runs it for the real blow; the caster's client to guess on the click.
 */
export function poleStrike(
  casterId: string,
  caster: WindPolePoint,
  yaw: number,
  players: Iterable<[string, WindPoleTarget]>,
  obstacles: Iterable<Obstacle> = [],
): WindPoleStrike | null {
  const walls = [...obstacles];
  const forwardX = -Math.sin(yaw);
  const forwardY = -Math.cos(yaw);
  const from = { x: caster.x, y: caster.y, z: caster.z + CHEST };

  let best: { strike: WindPoleStrike; distance: number } | null = null;
  for (const [id, target] of players) {
    if (id === casterId || target.hp <= 0) { continue; }

    const dx = target.x - caster.x;
    const dy = target.y - caster.y;
    const distance = Math.hypot(dx, dy);
    if (distance > WIND_POLE.meleeReach + PLAYER_HALF) { continue; }
    if (distance > EPSILON && (dx * forwardX + dy * forwardY) / distance < COS_HALF_ANGLE) { continue; }
    if (Math.abs(target.z - caster.z) > WIND_POLE.meleeVerticalReach) { continue; }
    if (best && distance >= best.distance) { continue; }

    // On the body's near side, facing the caster, at chest height.
    const toward = distance > EPSILON ? PLAYER_HALF / distance : 0;
    const at = { x: target.x - dx * toward, y: target.y - dy * toward, z: target.z + CHEST };
    if (lineBlocked(from, at, walls) !== null) { continue; }
    best = { strike: { hitId: id, ...at }, distance };
  }
  return best?.strike ?? null;
}

/**
 * The launch rule: from the pole's end beside the eyes, along the view. The
 * server runs it for the real gust and the caster's client for the one it
 * throws on the click, so both fly the same line. At yaw 0 forward is -y
 * and right is +x. Pitch tilts the throw up or down, clamped like the camera's.
 */
export function launchWindBlast(caster: WindPolePoint, aim: WindPoleAim): WindBlastLaunch {
  const tilt = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, aim.pitch));
  const sin = Math.sin(aim.yaw);
  const cos = Math.cos(aim.yaw);
  const flat = Math.cos(tilt) * WIND_POLE.speed;
  return {
    x: caster.x + cos * WIND_POLE.handOffset,
    y: caster.y - sin * WIND_POLE.handOffset,
    z: caster.z + EYE_HEIGHT,
    vx: -sin * flat,
    vy: -cos * flat,
    vz: Math.sin(tilt) * WIND_POLE.speed,
  };
}

/** Where a gust thrown like this is `t` seconds after launch: a straight line. */
export function windBlastPosition(launch: WindBlastLaunch, t: number): WindPolePoint {
  return { x: launch.x + launch.vx * t, y: launch.y + launch.vy * t, z: launch.z + launch.vz * t };
}

/**
 * If a gust here touches an arena wall or the floor, the point it breaks
 * at — against the surface, not past it; otherwise null.
 */
export function windBlastSurfaceHit(p: WindPolePoint): WindPolePoint | null {
  const r = WIND_POLE.radius;
  const outside = p.x < r || p.x > ARENA_WIDTH - r || p.y < r || p.y > ARENA_HEIGHT - r || p.z < r;
  if (!outside) { return null; }
  return {
    x: Math.min(ARENA_WIDTH - r, Math.max(r, p.x)),
    y: Math.min(ARENA_HEIGHT - r, Math.max(r, p.y)),
    z: Math.max(r, p.z),
  };
}

/**
 * How far a point is from a player's body — an upright cylinder, feet to
 * head — in simulation units; 0 inside it.
 */
export function distanceToWindTarget(body: WindPolePoint, p: WindPolePoint) {
  const across = Math.max(0, Math.hypot(body.x - p.x, body.y - p.y) - PLAYER_HALF);
  const up = Math.max(0, body.z - p.z, p.z - (body.z + PLAYER_HEIGHT));
  return Math.hypot(across, up);
}

/**
 * The gust's hit rule: the living body other than the caster's that a gust
 * here touches — the closest, should it graze two at once — or undefined.
 */
export function windBlastStruck(
  ownerId: string,
  at: WindPolePoint,
  players: Iterable<[string, WindPoleTarget]>,
): string | undefined {
  let best: { id: string; distance: number } | undefined;
  for (const [id, player] of players) {
    if (id === ownerId || player.hp <= 0) { continue; }
    const distance = distanceToWindTarget(player, at);
    if (distance > WIND_POLE.radius) { continue; }
    if (!best || distance < best.distance) { best = { id, distance }; }
  }
  return best?.id;
}

/**
 * Server → everyone: a swing. The caster's next one is ready in
 * `cooldownMs`. Either the pole struck someone in reach (`strike`: who and
 * where), or it threw gust `id` from this launch: every client flies it
 * itself — positions are never synced, only where it breaks.
 */
export type WindPoleCast = { casterId: string; cooldownMs: number } & (
  | { kind: "strike"; strike: WindPoleStrike }
  | ({ kind: "blast"; id: number } & WindBlastLaunch)
);

/** Server → everyone: gust `id` broke here — on `hitId` (struck), or on a wall or the floor. */
export interface WindPoleHit { id: number; x: number; y: number; z: number; hitId?: string; }
