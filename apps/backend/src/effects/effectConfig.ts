/**
 * Status effects: timed conditions on a player (burning, chilled, shielded, …).
 * Add an effect by naming it in `EFFECTS`; make it land by naming it in
 * `ABILITY_EFFECTS` (on every hit of an ability), from a skill through
 * `SkillRoom.applyEffect`, or in a ground zone.
 */
import type { KillAbility } from "../shared/combat.js";
import { STONE_SKIN } from "../skills/stoneSkin/stoneSkinConfig.js";
import { SKYFALL } from "../skills/skyfall/skyfallConfig.js";
import { BURROW } from "../skills/burrow/burrowConfig.js";

export type EffectId = string;

/** What an effect does while it lasts. Every field but the duration is optional. */
export interface EffectDef {
  /** From the latest application: applying it again restarts the timer. */
  durationMs: number;
  /** Multiplies each hit the player takes (0.5 = half damage, 2 = double). */
  damageTakenScale?: number;
  /** Damage over time: `damage` every `everyMs`, credited to whoever applied it. */
  tick?: { everyMs: number; damage: number };
  /**
   * Multiplies walking speed (0.7 = 30% slower, 0 = can't walk; 1.3 = 30%
   * faster). With several, the strongest slow and the strongest boost count,
   * multiplied — slows don't stack, nor do boosts.
   */
  moveSpeedScale?: number;
  /** Can't jump while it lasts (already in the air, they still fall). */
  noJump?: boolean;
  /** Can't cast any skill while it lasts; a channel in progress stops. */
  noCast?: boolean;
  /** Raised walls don't stop them while it lasts: they pass under them. */
  underWalls?: boolean;
  /** Out of reach while it lasts: no hit hurts them, and nobody else's effect lands on them. */
  untargetable?: boolean;
}

/** How a player may move, from the effects on them. */
export interface MoveLimits {
  speedScale: number;
  canJump: boolean;
}

/**
 * How effects `ids` limit movement. Shared: the server steps with it and the
 * client predicts with it, both reading the synced `Player.effects`, so the
 * prediction slows down exactly as the server does once the effect arrives.
 * Unknown ids (a newer server) limit nothing.
 */
export function moveLimits(ids: Iterable<EffectId>, defs: Readonly<Record<EffectId, EffectDef>> = EFFECTS): MoveLimits {
  let slow = 1;
  let boost = 1;
  let canJump = true;
  for (const id of ids) {
    const def = Object.hasOwn(defs, id) ? defs[id] : undefined;
    if (!def) { continue; }
    slow = Math.min(slow, def.moveSpeedScale ?? 1);
    boost = Math.max(boost, def.moveSpeedScale ?? 1);
    if (def.noJump) { canJump = false; }
  }
  return { speedScale: slow * boost, canJump };
}

/** Whether a player with effects `ids` may cast. Shared, like `moveLimits`. */
export function canCast(ids: Iterable<EffectId>, defs: Readonly<Record<EffectId, EffectDef>> = EFFECTS): boolean {
  for (const id of ids) {
    if (Object.hasOwn(defs, id) && defs[id].noCast) { return false; }
  }
  return true;
}

/** Whether raised walls stop a player with effects `ids`. Shared, like `moveLimits`. */
export function blockedByWalls(ids: Iterable<EffectId>, defs: Readonly<Record<EffectId, EffectDef>> = EFFECTS): boolean {
  for (const id of ids) {
    if (Object.hasOwn(defs, id) && defs[id].underWalls) { return false; }
  }
  return true;
}

/** Whether a player with effects `ids` is out of reach of everyone else's hits and effects. */
export function isUntargetable(ids: Iterable<EffectId>, defs: Readonly<Record<EffectId, EffectDef>> = EFFECTS): boolean {
  for (const id of ids) {
    if (Object.hasOwn(defs, id) && defs[id].untargetable) { return true; }
  }
  return false;
}

/** Speed Boost (wind's Leap, Puff and Skyfall), on yourself: faster walking for a while. */
export const SPEED_BOOST = {
  /** How much faster you walk, in percent. */
  percent: 20,
  durationMs: 3000,
} as const;

/** Every effect the room knows. */
export const EFFECTS: Readonly<Record<EffectId, EffectDef>> = {
  /** 5 HP a second for 3 s: 15 in all. Doesn't stack — catching it again restarts the 3 s. */
  burn: { durationMs: 3000, tick: { everyMs: 1000, damage: 5 } },
  /**
   * 30% slower walking. 2 s by default (Torrent); a skill may apply it for
   * another duration (`SkillRoom.applyEffect`), never cutting a longer one short.
   */
  slow: { durationMs: 2000, moveSpeedScale: 0.7 },
  /** Water Whip's first lash and its shard: 10% slower walking for 1 s. */
  whip_slow_10: { durationMs: 1000, moveSpeedScale: 0.9 },
  /** Water Whip's second lash: 15% slower walking for 1 s. */
  whip_slow_15: { durationMs: 1000, moveSpeedScale: 0.85 },
  /** Frozen solid: can't walk, jump or cast. */
  frozen: { durationMs: 2500, moveSpeedScale: 0, noJump: true, noCast: true },
  /** Stunned (Rupture): can't walk, jump or cast — like a freeze, from another source. */
  stunned: { durationMs: 2000, moveSpeedScale: 0, noJump: true, noCast: true },
  /** Stone Skin, on yourself: less damage taken, slower walking — its numbers are in `STONE_SKIN`. */
  stone_skin: {
    durationMs: STONE_SKIN.durationMs,
    damageTakenScale: 1 - STONE_SKIN.damageReductionPercent / 100,
    moveSpeedScale: 1 - STONE_SKIN.walkSlowPercent / 100,
  },
  /** Faster walking; catching it again restarts the timer — its numbers are in `SPEED_BOOST`. */
  speed_boost: { durationMs: SPEED_BOOST.durationMs, moveSpeedScale: 1 + SPEED_BOOST.percent / 100 },
  /**
   * High in the sky (Skyfall), on yourself: slower walking, no jumping, and
   * maybe less damage taken — its numbers are in `SKYFALL`. The skill removes
   * it on landing; the duration is only a backstop.
   */
  soaring: {
    durationMs: SKYFALL.soarMs + 2000,
    damageTakenScale: 1 - SKYFALL.damageResistPercent / 100,
    moveSpeedScale: SKYFALL.soarWalkSpeedPercent / 100,
    noJump: true,
  },
  /**
   * Digging into the ground (Burrow), on yourself: rooted, no jumping or
   * casting, and already out of reach of every hit and effect. The skill
   * swaps it for `burrowed` when the dig is done; the duration is only a backstop.
   */
  burrowing: { durationMs: BURROW.digMs + 500, moveSpeedScale: 0, noJump: true, noCast: true, untargetable: true },
  /**
   * Under the ground (Burrow), on yourself: much faster walking, under walls,
   * out of reach of every hit and effect, no jumping or casting (bursting out is the skill's own
   * message). The skill removes it on surfacing; the duration is only a backstop.
   */
  burrowed: {
    durationMs: BURROW.underMs + 500,
    moveSpeedScale: BURROW.speedScale,
    noJump: true,
    noCast: true,
    underWalls: true,
    untargetable: true,
  },
};

/**
 * Effects an ability puts on every player it damages, once the hit lands —
 * e.g. `fireball: ["burn"]`. Damage that effects deal themselves never
 * triggers this, so a burning victim isn't re-ignited by their own burn.
 */
export const ABILITY_EFFECTS: Readonly<Partial<Record<KillAbility, readonly EffectId[]>>> = {
  /** A stream's head and the blast where they meet (the fire left on the ground lays Burn itself). */
  twin_dragons: ["burn"],
  torrent: ["slow"],
};
