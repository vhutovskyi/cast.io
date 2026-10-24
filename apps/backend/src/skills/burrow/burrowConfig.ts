/**
 * Burrow's numbers and payloads. Shared code: the frontend imports this
 * file too, so it must stay pure — no imports beyond shared constants and types.
 */
import { PLAYER_SPEED, TICK_RATE } from "../../shared/constants.js";

/**
 * Burrow (earth's third skill): the mage digs into the ground where they
 * stand — rooted for `digMs` (`burrowing`) — then travels under it for
 * `underMs` (`burrowed`) at `speedScale` × a walk, under walls. Out of reach
 * of every attack from the moment they start digging until they surface. Only a mound of churned earth shows where they are. The
 * view stays where it is: the camera never goes underground. A click while
 * under bursts out, hurting everyone within `eruptRadius` once; when the
 * time runs out they surface quietly, hurting no one.
 */
export const BURROW = {
  cooldownMs: 6_500,
  /** Digging in, rooted, before they are under. */
  digMs: 350,
  /** Travelling under the ground, from the end of the dig. */
  underMs: 2500,
  /** Walk speed multiplier while under: 2.5 × `PLAYER_SPEED`. */
  speedScale: 2.5,
  /** To every living enemy within `eruptRadius` when they burst out with a click. */
  eruptDamage: 10,
  /** Centre to centre along the floor, in simulation units. */
  eruptRadius: 60,
  /** Upward speed bursting out: a jump out of the ground. */
  eruptJumpSpeed: 260,
} as const;

/** Burrowed speed, in simulation units per second. */
export const BURROW_SPEED = PLAYER_SPEED * BURROW.speedScale;

/**
 * The dig and the time under, in the caster's own movement steps: the room
 * counts them as it applies the caster's inputs, so their client — which
 * predicts being rooted, then fast under the walls — knows the very step each
 * phase ends on.
 */
export const BURROW_DIG_STEPS = Math.round((BURROW.digMs / 1000) * TICK_RATE);
export const BURROW_UNDER_STEPS = Math.round((BURROW.underMs / 1000) * TICK_RATE);

/** Bursting out: a jump out of the ground on the next movement step. Shared: the room, and the caster's client predicting it. */
export function startBurrowErupt(body: { vz: number }) {
  body.vz = BURROW.eruptJumpSpeed;
}

/**
 * Server → everyone: `casterId` started digging in at `x, y`, feet at height
 * `z` (the ground there); they are under `digMs` later, for `underMs`. The
 * caster counts its cooldown (`cooldownMs`) from this. Where they travel
 * shows in their synced position.
 */
export interface BurrowCast { casterId: string; cooldownMs: number; x: number; y: number; z: number; digMs: number; underMs: number; }

/**
 * Server → everyone: `casterId` came out of the ground at `x, y`, feet at
 * height `z` — bursting out with a click (`erupted`, hurting `hits`), or
 * quietly once their time ran out (`hits` empty).
 */
export interface BurrowSurface { casterId: string; x: number; y: number; z: number; erupted: boolean; hits: string[]; }
