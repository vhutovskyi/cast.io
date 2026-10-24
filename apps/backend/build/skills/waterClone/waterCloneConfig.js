/**
 * Water Clone's numbers, payloads and who-is-a-clone rules. Shared code: the
 * frontend imports this file too, so it must stay pure — no imports beyond
 * shared constants and types.
 */
import { PLAYER_HALF, PLAYER_HEIGHT } from "../../shared/constants.js";
import { WATER_WHIP } from "../waterWhip/waterWhipConfig.js";
/**
 * Water Clone (water's third skill): a mage of water steps out just ahead of
 * the caster, picks a target — the enemy under the aim, else the nearest —
 * walks up to them at a mage's pace (slows and freezes hold it too) and
 * lashes them with the Water Whip combo, over and over, until it is killed,
 * its owner dies or leaves, or its time runs out. One per caster at a time; the cooldown only
 * starts once it is gone. Its hits are credited to its owner.
 *
 * On the server a clone is a pseudo-player in `state.players` with
 * `Player.ownerId` set, so every enemy skill already hits it; everything
 * about real players (input, respawn, rounds, Ready, the kill feed) skips it.
 */
export const WATER_CLONE = {
    /** From the moment the clone is gone, not from the cast. */
    cooldownMs: 12_000,
    /** How long a clone lasts if no one kills it first. */
    lifetimeMs: 5_000,
    /** The clone's health: its own, nothing to do with `MAX_HP`. */
    hp: 15,
    /** What each of its whip hits deals: half a mage's. */
    damage: WATER_WHIP.damage / 2,
    /** Where it steps out: this far ahead of the caster, centre to centre along the floor. */
    spawnDistance: PLAYER_HALF * 2 + 6,
    /** Picking the target under the aim: how far along the view a body may be... */
    aimRange: 1000,
    /** ...and how far off the aimed line its centre may be (a generous body's width). */
    aimRadius: PLAYER_HALF * 2,
    /** It walks until its target is this close, centre to centre along the floor: well inside its attack range. */
    stopRange: WATER_WHIP.range * 0.4,
    /** It lashes whenever its target is this close: half the whip's reach, to a body's edge. */
    attackRange: WATER_WHIP.range / 2 + PLAYER_HALF,
    /**
     * ...and no more than this far above or below it, feet to feet: a jump or a
     * hill, never someone up in the sky (Skyfall) — them it waits out below.
     */
    attackHeight: PLAYER_HEIGHT * 1.5,
};
/** Whether a `state.players` entry is a Water Clone rather than a real player. */
export function isWaterClone(player) {
    return player !== undefined && !!player.ownerId;
}
/**
 * Friendly fire: whether a hit or effect from `sourceId` on `victim` is
 * dropped — a clone's own owner can't hurt it, nor put anything on it.
 */
export function sparedAsOwnClone(victim, sourceId) {
    return isWaterClone(victim) && sourceId !== undefined && victim.ownerId === sourceId;
}
