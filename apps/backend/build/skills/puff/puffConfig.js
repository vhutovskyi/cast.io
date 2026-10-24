/**
 * Puff's numbers and payloads. Shared code: the frontend imports this
 * file too, so it must stay pure — no imports beyond shared constants and types.
 */
import { PLAYER_HALF, PLAYER_HEIGHT } from "../../shared/constants.js";
/**
 * Puff (wind): a burst of wind all around the caster — no aim, no target.
 * Every living enemy it reaches is hurt and blown away from the caster (a
 * forced slide, `Player.dash*`, with a little hop), and the caster runs off
 * with a speed boost (`speed_boost`) — on every cast, hit or miss.
 */
export const PUFF = {
    cooldownMs: 7000,
    /** To each enemy it reaches. */
    damage: 10,
    /** How far the burst blows out from the caster's centre, along the floor: about four bodies. */
    radius: 90,
    /** A body whose feet are further than this above or below the caster's is out of it: a Skyfall soar is. */
    heightReach: PLAYER_HEIGHT * 1.5,
    /** How fast it blows its victims away, in simulation units per second... */
    pushSpeed: 480,
    /** ...and for how long: ~120 units, unless a wall or the arena's edge stops them. */
    pushMs: 250,
    /** Upward speed it pops a grounded victim with: a small hop, ~16 units high. */
    popSpeed: 150,
};
/** Who it reaches, centre to centre along the floor: the burst and a body's half-width. */
export const PUFF_REACH = PUFF.radius + PLAYER_HALF;
