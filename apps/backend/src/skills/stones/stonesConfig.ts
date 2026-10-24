/**
 * Stone Fists' numbers, payloads and path. Shared code: the frontend imports
 * this file too, so it must stay pure — no imports beyond shared constants and types.
 */
import { ARENA_WIDTH, ARENA_HEIGHT, PLAYER_HALF, PLAYER_HEIGHT } from "../../shared/constants.js";

/**
 * Stone Fists (earth's main skill, id `stones`): two fists of stone float at
 * the caster's sides, for everyone to see. Every click punches one, right then
 * left then right…, straight out along the caster's facing, level with the
 * floor: it strikes the first living enemy it touches, alone, or breaks on a
 * wall. That side's fist re-forms before it is due again. No reload: the only
 * limit is the time between punches.
 */
export const STONE_FISTS = {
  /** To the one player a fist strikes. */
  damage: 6,
  /** Shortest time between two punches, whichever hands throw them. */
  punchIntervalMs: 400,
  /** Punch speed, in simulation units per second: straight, it never slows or drops. */
  speed: 900,
  /** Hit radius around the fist, in simulation units: what it breaks on touching. */
  radius: 9,
  /** How long a punch flies before crumbling: its reach is `speed` × this, 360 units — under half the arena. */
  lifetimeMs: 400,
  /** Where a fist is punched from: this far ahead of the caster's centre… */
  handAhead: 14,
  /** …this far to the punching side… */
  handSide: 14,
  /** …at this height above their feet (about the chest). */
  handHeight: 28,
} as const;

/** Which of the caster's fists: the first punch of a round is always the right. */
export type FistSide = "right" | "left";

/** The other fist: the one due next after this one. */
export function otherSide(side: FistSide): FistSide {
  return side === "right" ? "left" : "right";
}

/** Client → server: punch the next fist along this facing (radians, as in `MouseLook`). */
export interface StonesAim { yaw: number; }

/** Where a fist leaves the hand (simulation units) and its velocity (units per second). */
export interface FistLaunch { x: number; y: number; z: number; vx: number; vy: number; vz: number; }

export interface FistPoint { x: number; y: number; z: number; }

/** A body a fist may strike: anyone in the room. */
export interface FistTarget extends FistPoint { hp: number; }

/**
 * The one launch rule: from the punching side's hand, ahead of the caster at
 * chest height, level along their facing. The server runs it for the real
 * fist and the caster's client for the one it punches on the click, so both
 * fly the same line. Same convention as `stepEntity`: at yaw 0 forward is -y,
 * and right is +x.
 */
export function launchFist(caster: FistPoint, aim: StonesAim, side: FistSide): FistLaunch {
  const forwardX = -Math.sin(aim.yaw);
  const forwardY = -Math.cos(aim.yaw);
  // Forward turned a quarter clockwise, seen from above.
  const rightX = Math.cos(aim.yaw);
  const rightY = -Math.sin(aim.yaw);
  const across = side === "right" ? STONE_FISTS.handSide : -STONE_FISTS.handSide;
  return {
    x: caster.x + forwardX * STONE_FISTS.handAhead + rightX * across,
    y: caster.y + forwardY * STONE_FISTS.handAhead + rightY * across,
    z: caster.z + STONE_FISTS.handHeight,
    vx: forwardX * STONE_FISTS.speed,
    vy: forwardY * STONE_FISTS.speed,
    vz: 0,
  };
}

/**
 * Where a fist punched like this is `t` seconds after launch. The server
 * strikes along it, every client draws it — same path everywhere.
 */
export function fistPosition(launch: FistLaunch, t: number): FistPoint {
  return {
    x: launch.x + launch.vx * t,
    y: launch.y + launch.vy * t,
    z: launch.z + launch.vz * t,
  };
}

/**
 * Longest step along the path, in seconds, that can't carry the fist further
 * than its own radius — so it never skips through a body or a wall.
 */
export function fistStepFrom() {
  return STONE_FISTS.radius / STONE_FISTS.speed;
}

/**
 * If a fist here touches an arena wall or the floor, the point it breaks
 * at — against the surface, not past it; otherwise null.
 */
export function fistSurfaceHit(p: FistPoint): FistPoint | null {
  const r = STONE_FISTS.radius;
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
export function distanceToFistTarget(body: FistPoint, p: FistPoint) {
  const across = Math.max(0, Math.hypot(body.x - p.x, body.y - p.y) - PLAYER_HALF);
  const up = Math.max(0, body.z - p.z, p.z - (body.z + PLAYER_HEIGHT));
  return Math.hypot(across, up);
}

/**
 * The one hit rule: the living body other than the caster's that a fist
 * here touches — the closest, should it graze two at once — or undefined.
 */
export function fistStruck(
  ownerId: string,
  at: FistPoint,
  players: Iterable<[string, FistTarget]>,
): string | undefined {
  let best: { id: string; distance: number } | undefined;
  for (const [id, player] of players) {
    if (id === ownerId || player.hp <= 0) { continue; }
    const distance = distanceToFistTarget(player, at);
    if (distance > STONE_FISTS.radius) { continue; }
    if (!best || distance < best.distance) { best = { id, distance }; }
  }
  return best?.id;
}

/**
 * Server → everyone: fist `id` is in the air, punched by `casterId`'s `side`
 * hand — every client flies it from this launch itself; positions are never
 * synced, only where it breaks. The caster's next punch is ready in
 * `cooldownMs`, from the other hand.
 */
export interface StoneFistPunched extends FistLaunch { id: number; casterId: string; side: FistSide; cooldownMs: number; }

/** Server → everyone: fist `id` broke here — on `hitId` (struck), or on a wall or the floor. */
export interface StoneFistHit { id: number; x: number; y: number; z: number; hitId?: string; }
