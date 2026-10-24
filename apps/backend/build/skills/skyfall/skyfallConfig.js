/**
 * Skyfall's numbers and payloads. Shared code: the frontend imports this
 * file too, so it must stay pure — no imports beyond shared constants and types.
 */
import { ARENA_WIDTH, ARENA_HEIGHT, GRAVITY, PLAYER_HALF, TICK_RATE } from "../../shared/constants.js";
/**
 * Skyfall (wind's ultimate): soar high into the sky, drift there at reduced
 * speed for a while, then drop onto a chosen ground point — hurting everyone
 * near where you land — and run off with a speed boost (`speed_boost`).
 *
 * Two parts, so it can work indoors later: rise to `soarHeight` (today a
 * constant; under a roof, the ceiling), then `leapToward` a ground point from
 * whatever height you are at.
 */
export const SKYFALL = {
    /** How long you may stay up before you drop on your own, in ms. */
    soarMs: 3000,
    /** Walking speed while soaring, in percent of normal. */
    soarWalkSpeedPercent: 50,
    /** Less damage taken while soaring, in percent. 0 for now: enemies hurt you as usual. */
    damageResistPercent: 0,
    cooldownMs: 20_000,
    /** Feet above the floor at the top: ten bodies up, a dozen jumps. */
    height: 420,
    /** How far from the point below you the drop may land, along the floor. */
    dropRange: 320,
    /** Downward speed the drop starts with — a plunge, not a float: ~0.6 s down from the top. */
    dropSpeed: 450,
    damage: 20,
    /** Everyone whose body is this close to where you land, along the floor, is hit. */
    radius: 95,
    /** The shockwave runs along the floor: bodies higher than this off it are spared. */
    groundReach: 40,
};
/**
 * How high a Skyfall carries you from (`x`, `y`). The single place to cap it:
 * indoors this becomes the ceiling above that point, less a body's height.
 */
export function soarHeight(_at) {
    return SKYFALL.height;
}
/**
 * Where a drop aimed at `target` from above `origin` really lands: pulled in
 * along the line to within range, and inside the arena where a body fits.
 * The server leaps there and the caster's client previews the same spot.
 */
export function clampSkyfallTarget(origin, target) {
    let dx = target.x - origin.x;
    let dy = target.y - origin.y;
    const distance = Math.hypot(dx, dy);
    if (distance > SKYFALL.dropRange) {
        dx *= SKYFALL.dropRange / distance;
        dy *= SKYFALL.dropRange / distance;
    }
    return {
        x: Math.min(ARENA_WIDTH - PLAYER_HALF, Math.max(PLAYER_HALF, origin.x + dx)),
        y: Math.min(ARENA_HEIGHT - PLAYER_HALF, Math.max(PLAYER_HALF, origin.y + dy)),
    };
}
/**
 * How many movement steps a fall from height `z`, starting at vertical speed
 * `vz`, takes to reach the floor — integrated exactly as `stepEntity` does
 * (semi-implicit, one tick at a time), so the slide below ends on the very
 * step the feet touch down. At least one.
 */
export function fallSteps(z, vz) {
    const dt = 1 / TICK_RATE;
    let steps = 0;
    do {
        vz -= GRAVITY * dt;
        z += vz * dt;
        steps++;
    } while (z > 0 && steps < 10 * TICK_RATE);
    return steps;
}
/**
 * Steps of soaring before the drop comes on its own: counted in the caster's
 * own movement steps, so their client knows the very step it comes on.
 */
export const SKYFALL_SOAR_STEPS = Math.round((SKYFALL.soarMs / 1000) * TICK_RATE);
/**
 * Takes `body` up: it rises to `soarHeight` from its next movement step on.
 * Shared: the room on the step the caster pressed it, the caster's client
 * predicting that same step. Returns the height.
 */
export function startSkyfall(body) {
    body.flightZ = soarHeight(body);
    return body.flightZ;
}
/**
 * Up and all the way risen: the step that leaps down comes after this one.
 * Shared, like `startSkyfall`.
 */
export function skyfallRisen(body) {
    return body.flightZ > 0 && body.z >= body.flightZ;
}
/**
 * Ends the flight with the leap down onto `aim`, pulled into range: the
 * movement steps from here carry `body` there. Shared, like `startSkyfall`.
 * Returns where it lands and the leap.
 */
export function startSkyfallDrop(body, aim) {
    const target = clampSkyfallTarget(body, aim);
    const leap = leapToward(body, target, -SKYFALL.dropSpeed);
    body.flightZ = 0;
    body.vz = leap.vz;
    body.dashVx = leap.dashVx;
    body.dashVy = leap.dashVy;
    body.dashTime = leap.dashTime;
    return { target, leap };
}
/**
 * A leap from wherever `from` is — the sky, a ceiling, a ledge — down onto
 * `target`: start falling at `vz` (≤ 0 plunges) and slide along the floor at
 * whatever speed gets there on the step you land. Any height works; set the
 * returned fields on the body, with its flight cleared.
 */
export function leapToward(from, target, vz) {
    const steps = fallSteps(from.z, vz);
    const seconds = steps / TICK_RATE;
    return {
        dashVx: (target.x - from.x) / seconds,
        dashVy: (target.y - from.y) / seconds,
        // Half a step short of `steps` whole ones: rounding never adds a step.
        dashTime: (steps - 0.5) / TICK_RATE,
        vz,
    };
}
