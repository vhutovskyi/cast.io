/**
 * Stone Skin's numbers and payloads. Shared code: the frontend imports this
 * file too, so it must stay pure — no imports beyond shared constants and types.
 */
import { PLAYER_HALF } from "../../shared/constants.js";

/**
 * Stone Skin (earth): harden into stone on the spot — no aim, no target.
 * While it lasts (the `stone_skin` status effect, built from these numbers)
 * every hit on you does less damage and you walk slower — and any enemy who
 * touches you is hurt, once per hardening.
 */
export const STONE_SKIN = {
  cooldownMs: 12_000,
  /** How long it stays active. */
  durationMs: 3000,
  /** How much slower you walk while it's active, in percent. */
  walkSlowPercent: 20,
  /** How much less damage every hit does to you while it's active, in percent. */
  damageReductionPercent: 50,
  /** To an enemy who touches you while it's active — once per enemy per hardening. */
  contactDamage: 10,
  /** Bodies this close, centre to centre along the floor, are touching: two bodies' half-widths and a hair. */
  contactDistance: PLAYER_HALF * 2 + 2,
} as const;

/** Server → everyone: `casterId` hardened. The caster counts its cooldown from this. */
export interface StoneSkinCast { casterId: string; cooldownMs: number; }

/** Server → everyone: `victimId` touched `casterId`'s stone skin and was hurt. */
export interface StoneSkinContact { casterId: string; victimId: string; }
