/**
 * Freezing Stream's numbers, payloads and path. Shared code: the frontend
 * imports this file too, so it must stay pure — no imports beyond shared constants and types.
 */
import { ARENA_WIDTH, ARENA_HEIGHT, EYE_HEIGHT, PITCH_LIMIT, PLAYER_HALF, PLAYER_HEIGHT } from "../../shared/constants.js";
import { obstacleAt, type Obstacle } from "../../shared/obstacles.js";

/**
 * Freezing Stream (water's ultimate), after Sub-Zero's ice blast: a fast,
 * narrow jet of icy water fired from the right hand along the view. Its head
 * races out in a straight line — fast, but it can be seen coming and side-
 * stepped — and the first living enemy it touches takes the hit and is frozen
 * solid (`frozen`: no walking, jumping or casting). A wall, the floor or the
 * end of its reach stops it harmlessly.
 */
export const FREEZING_STREAM = {
  /** To the one body the head strikes. */
  damage: 15,
  /** How long the victim stays frozen. */
  freezeMs: 2500,
  cooldownMs: 30_000,
  /** How fast the head travels, in simulation units per second: full reach in 0.6 s. */
  speed: 800,
  /** How far the head goes before it runs out, along its line, in simulation units. */
  range: 480,
  /** The head's radius: it strikes bodies, walls and the floor within this of its centre. */
  radius: 8,
  /** Launch point: this far to the caster's right of their eyes. */
  handOffset: 10,
} as const;

/** How long a stream takes to reach its full range, in ms. */
export const FREEZING_STREAM_TRAVEL_MS = (FREEZING_STREAM.range / FREEZING_STREAM.speed) * 1000;

/** Client → server: fire along the camera direction (radians, as in `MouseLook`). */
export interface FreezingStreamAim { yaw: number; pitch: number; }

export interface FreezingStreamPoint { x: number; y: number; z: number; }

/** Where a stream leaves the hand (simulation units) and the unit direction its head travels in. */
export interface FreezingStreamLaunch extends FreezingStreamPoint { dx: number; dy: number; dz: number; }

/** A body the head may strike: anyone in the room. */
export interface FreezingStreamTarget extends FreezingStreamPoint { hp: number; /** A Water Clone's owner, if it is one: never stopped by its own owner's stream. */ ownerId?: string; }

/**
 * Where a stream's head stops, `distance` along its line from the hand: on
 * `hitId`'s body, against a wall or the floor, or at the end of its reach.
 */
export interface FreezingStreamStop { distance: number; at: FreezingStreamPoint; hitId?: string; }

/**
 * The one launch rule: from the right hand beside the eyes, along the view.
 * Same convention as `stepEntity`: at yaw 0 forward is -y and right is +x.
 * Pitch tilts it up or down, clamped like the camera's.
 */
export function launchFreezingStream(caster: FreezingStreamPoint, aim: FreezingStreamAim): FreezingStreamLaunch {
  const tilt = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, aim.pitch));
  const sin = Math.sin(aim.yaw);
  const cos = Math.cos(aim.yaw);
  const flat = Math.cos(tilt);
  return {
    x: caster.x + cos * FREEZING_STREAM.handOffset,
    y: caster.y - sin * FREEZING_STREAM.handOffset,
    z: caster.z + EYE_HEIGHT,
    dx: -sin * flat,
    dy: -cos * flat,
    dz: Math.sin(tilt),
  };
}

/** Where the head of a stream launched like this is once it has come `distance` units. */
export function freezingStreamPosition(launch: FreezingStreamLaunch, distance: number): FreezingStreamPoint {
  return {
    x: launch.x + launch.dx * distance,
    y: launch.y + launch.dy * distance,
    z: launch.z + launch.dz * distance,
  };
}

/**
 * If a head here touches a wall or the floor, the point it stops at —
 * against the surface, not past it; otherwise null.
 */
export function freezingStreamSurfaceStop(p: FreezingStreamPoint): FreezingStreamPoint | null {
  const r = FREEZING_STREAM.radius;
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
function distanceToBody(body: FreezingStreamPoint, p: FreezingStreamPoint) {
  const across = Math.max(0, Math.hypot(body.x - p.x, body.y - p.y) - PLAYER_HALF);
  const up = Math.max(0, body.z - p.z, p.z - (body.z + PLAYER_HEIGHT));
  return Math.hypot(across, up);
}

/**
 * The one hit rule: sweeps the head from `from` to `to` units along its line
 * (never past its range) in steps no longer than its radius, so it can't skip
 * through a body or a wall, and returns where it stops on that stretch — on
 * the first living body other than the caster's it touches (the nearest one,
 * if it touches several at once), on a wall, a raised obstacle or the floor,
 * or at the end of its reach — or null if it flies on. The server runs it
 * every step; the caster's client runs it with `players` empty for the aim preview.
 */
export function sweepFreezingStream(
  launch: FreezingStreamLaunch,
  from: number,
  to: number,
  casterId: string,
  players: Iterable<[string, FreezingStreamTarget]>,
  obstacles: Iterable<Obstacle> = [],
): FreezingStreamStop | null {
  const end = Math.min(to, FREEZING_STREAM.range);
  const walls = [...obstacles];
  const bodies = [...players].filter(([id, target]) => id !== casterId && target.ownerId !== casterId && target.hp > 0);
  const samples = Math.max(1, Math.ceil((end - from) / FREEZING_STREAM.radius));
  for (let i = 1; i <= samples; i++) {
    const distance = from + ((end - from) * i) / samples;
    const at = freezingStreamPosition(launch, distance);

    let best: { id: string; gap: number } | undefined;
    for (const [id, target] of bodies) {
      const gap = distanceToBody(target, at);
      if (gap <= FREEZING_STREAM.radius && (!best || gap < best.gap)) { best = { id, gap }; }
    }
    if (best) { return { distance, at, hitId: best.id }; }

    const surface = freezingStreamSurfaceStop(at);
    if (surface) { return { distance, at: surface }; }
    if (obstacleAt(at, FREEZING_STREAM.radius, walls)) { return { distance, at }; }
  }
  return end >= FREEZING_STREAM.range ? { distance: end, at: freezingStreamPosition(launch, end) } : null;
}

/**
 * Where a stream launched like this stops if no one is in the way: a wall,
 * the floor, or the end of its reach. The end of the caster's aim line.
 */
export function freezingStreamReach(launch: FreezingStreamLaunch, obstacles: Iterable<Obstacle> = []): FreezingStreamStop {
  return sweepFreezingStream(launch, 0, FREEZING_STREAM.range, "", [], obstacles)!;
}

/**
 * Server → everyone: accepted. The caster's next one is `cooldownMs` away,
 * and stream `id` is on its way: every client runs its head out from this
 * launch at `FREEZING_STREAM.speed` itself — positions are never synced,
 * only where it stops is announced.
 */
export interface FreezingStreamCast extends FreezingStreamLaunch { id: number; casterId: string; cooldownMs: number; }

/**
 * Server → everyone: stream `id`'s head stopped `distance` along its line,
 * at `x, y, z` — on `hitId` (struck and frozen), or against a wall, the floor
 * or the end of its reach if there is none.
 */
export interface FreezingStreamHit extends FreezingStreamPoint { id: number; distance: number; hitId?: string; }
