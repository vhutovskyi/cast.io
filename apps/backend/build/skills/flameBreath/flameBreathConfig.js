/**
 * Flame Breath's numbers and payloads. Shared code: the frontend and the
 * shared movement step import this file too, so it must stay pure — no
 * imports beyond shared constants and types.
 */
/**
 * Flame Breath (fire): hold to channel a cone of fire along your facing. It
 * burns every other player inside the cone on a fixed beat, slows you while
 * you breathe, and goes on cooldown once you let go or run out of breath.
 * Breathing is an input (like jump), so the slowdown is predicted.
 */
export const FLAME_BREATH = {
    /** Cone length from the caster's centre, in simulation units. */
    range: 140,
    /** Half the cone's opening, either side of the caster's facing. */
    halfAngleDeg: 35,
    /**
     * The flames stay level — the input carries no pitch — so a target is in
     * reach when its body (feet to head) overlaps the caster's eye height ± this.
     * About half a body: a target jumping right in front still burns, but a
     * caster at the top of a jump breathes over the heads of those standing.
     */
    verticalReach: 22,
    /** One burn every this long of channelling, starting the moment it begins. */
    tickMs: 200,
    /** Per burn: 25 DPS. */
    tickDamage: 5,
    /** A channel ends by itself after this long. */
    maxChannelMs: 2000,
    /** Counted from the end of the channel. */
    cooldownMs: 6000,
    /** Walking speed while breathing, as a fraction of normal. */
    moveSpeedScale: 0.5,
};
