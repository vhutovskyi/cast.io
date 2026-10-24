/**
 * Sun Strike's numbers and payloads. Shared code: the frontend imports this
 * file too, so it must stay pure — no imports beyond shared constants and types.
 */
import { PLAYER_HALF } from "../../shared/constants.js";
/**
 * Sun Strike (fire), after Invoker's: target any point on the map; after a
 * delay a beam lands there and damages every *other* player inside it.
 * Only the caster sees it charging — enemies learn of it when it hits.
 */
export const SUN_STRIKE = {
    delayMs: 1700,
    damage: 30,
    cooldownMs: 5000,
    /** About two player-widths, in simulation units. */
    radius: PLAYER_HALF * 4,
};
