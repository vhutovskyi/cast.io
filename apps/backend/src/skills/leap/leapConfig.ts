/**
 * Leap's numbers and payloads. Shared code: the frontend imports this
 * file too, so it must stay pure — no imports beyond shared constants and types.
 */
import { PLAYER_HALF } from "../../shared/constants.js";

/**
 * Leap (wind): the mage dashes forward along their facing — level, along the
 * ground, no jump — through the shared forced slide (`dashVx`, `dashVy`,
 * `dashTime`), so nothing slows it and only walls and the arena's edge stop
 * it. Every enemy they touch on the way is hurt, once per leap; when it ends
 * the caster gets Speed Boost (`speed_boost`).
 */
export const LEAP = {
  cooldownMs: 6000,
  /**
   * How fast the mage slides, in simulation units per second: ~2.3× a walk.
   * No faster on purpose: 20 units a movement step stays under a body's
   * half-width plus a wall's half-thickness, so the slide can't skip through
   * an Earth Wall between two steps.
   */
  speed: 600,
  /**
   * How long the slide lasts: nine movement steps, 180 units. Just under 0.3 s
   * on purpose — counting 0.3 down by 1/30 leaves a float hair above zero,
   * which would add a tenth step.
   */
  durationMs: 290,
  /** To each enemy touched during the leap — once per enemy per leap. */
  damage: 15,
  /** Bodies this close, centre to centre along the floor, are touching: two bodies' half-widths and a little slack for the speed. */
  contactDistance: PLAYER_HALF * 2 + 6,
} as const;

/**
 * The slide's velocity along `yaw`, level: same convention as `stepEntity`,
 * at yaw 0 forward is -y.
 */
export function leapVelocity(yaw: number) {
  return { vx: -Math.sin(yaw) * LEAP.speed, vy: -Math.cos(yaw) * LEAP.speed };
}

/**
 * Starts the slide along `yaw` on `body`. Shared: the room on the step the
 * caster pressed it, the caster's client predicting that same step — with the
 * facing as the input carries it (a float32), so both start the very same
 * slide. Returns its velocity.
 */
export function startLeap(body: { dashVx: number; dashVy: number; dashTime: number }, yaw: number) {
  const { vx, vy } = leapVelocity(yaw);
  body.dashVx = vx;
  body.dashVy = vy;
  body.dashTime = LEAP.durationMs / 1000;
  return { vx, vy };
}

/** Client → server: leap along this facing (radians, as in `MouseLook`). */
export interface LeapAim { yaw: number; }

/**
 * Server → everyone: `casterId` leapt from `x, y` along `yaw`, sliding for
 * `durationMs`. The caster counts its cooldown (`cooldownMs`) from this.
 */
export interface LeapCast { casterId: string; cooldownMs: number; x: number; y: number; yaw: number; durationMs: number; }

/** Server → everyone: `casterId`'s leap ran into `victimId` and hurt them. */
export interface LeapHit { casterId: string; victimId: string; }
