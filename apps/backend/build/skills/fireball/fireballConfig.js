/**
 * Fireball's numbers, payloads and path. Shared code: the frontend imports
 * this file too, so it must stay pure — no imports beyond shared constants and types.
 */
import { ARENA_WIDTH, ARENA_HEIGHT, EYE_HEIGHT, PITCH_LIMIT, PLAYER_HALF } from "../../shared/constants.js";
/**
 * Fireball (fire's main skill): lobbed from the right hand along the view like
 * a catapult shot, it arcs down under its own gravity and blows up on the
 * first player, wall or floor it touches, hurting everyone in the blast. The
 * next one grows in the hand over the cooldown, for everyone to see.
 */
export const FIREBALL = {
    /** To everyone in the blast. */
    damage: 10,
    cooldownMs: 1600,
    /** Base launch speed, in simulation units per second. */
    speed: 500,
    /**
     * Throw strength: multiplies the launch speed. Higher carries further for
     * the same aim (a level throw's reach grows with it, a lob's with its square).
     */
    power: 2,
    /** Pulls the ball down, in units/s² — what bends the throw into an arc. */
    gravity: 600,
    /** Sphere radius, in simulation units: what it bursts on touching. */
    radius: 8,
    /** Bodies within this of the burst point are caught in the blast. */
    blastRadius: PLAYER_HALF * 3,
    /** Safety net: every arc comes down well before this. */
    lifetimeMs: 4000,
    /** Launch point: this far to the caster's right of their eyes. */
    handOffset: 10,
};
/** How fast a fireball actually leaves the hand: base speed times power. */
export const FIREBALL_LAUNCH_SPEED = FIREBALL.speed * FIREBALL.power;
/**
 * The one launch rule: from the right hand beside the eyes, along the view.
 * The server runs it for the real ball and the caster's client for the one it
 * throws on the click, so both fly the same arc. Same convention as
 * `stepEntity`: at yaw 0 forward is -y and right is +x. Pitch tilts the throw
 * up or down, clamped like the camera's.
 */
export function launchFireball(caster, aim) {
    const tilt = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, aim.pitch));
    const sin = Math.sin(aim.yaw);
    const cos = Math.cos(aim.yaw);
    const flat = Math.cos(tilt) * FIREBALL_LAUNCH_SPEED;
    return {
        x: caster.x + cos * FIREBALL.handOffset,
        y: caster.y - sin * FIREBALL.handOffset,
        z: caster.z + EYE_HEIGHT,
        vx: -sin * flat,
        vy: -cos * flat,
        vz: Math.sin(tilt) * FIREBALL_LAUNCH_SPEED,
    };
}
/**
 * Where a ball thrown like this is `t` seconds after launch: the arc. The
 * server bursts along it, every client draws it — same path everywhere.
 */
export function fireballPosition(launch, t) {
    return {
        x: launch.x + launch.vx * t,
        y: launch.y + launch.vy * t,
        z: launch.z + launch.vz * t - 0.5 * FIREBALL.gravity * t * t,
    };
}
/**
 * Longest step along the arc, in seconds, from `t` that can't carry the ball
 * further than its own radius — so it never skips through a body or a wall.
 * Gravity only ever adds speed, so this bounds it from `t` on.
 */
export function fireballStepFrom(t, span) {
    const fastest = FIREBALL_LAUNCH_SPEED + FIREBALL.gravity * (t + span);
    return FIREBALL.radius / fastest;
}
/**
 * If a ball here touches a wall or the floor, the point it bursts at —
 * against the surface, not past it; otherwise null.
 */
export function fireballSurfaceBurst(p) {
    const r = FIREBALL.radius;
    const outside = p.x < r || p.x > ARENA_WIDTH - r || p.y < r || p.y > ARENA_HEIGHT - r || p.z < r;
    if (!outside) {
        return null;
    }
    return {
        x: Math.min(ARENA_WIDTH - r, Math.max(r, p.x)),
        y: Math.min(ARENA_HEIGHT - r, Math.max(r, p.y)),
        z: Math.max(r, p.z),
    };
}
/**
 * Where (and how many seconds after launch) a ball thrown like this lands on
 * a wall or the floor if no one is in the way: the end of the caster's aim
 * line. Walks the arc in the same radius-sized steps the server flies it in.
 */
export function fireballLanding(launch) {
    const end = FIREBALL.lifetimeMs / 1000;
    let t = 0;
    while (t < end) {
        t = Math.min(end, t + fireballStepFrom(t, 0));
        const burst = fireballSurfaceBurst(fireballPosition(launch, t));
        if (burst) {
            return { ...burst, t };
        }
    }
    return { ...fireballPosition(launch, end), t: end };
}
/**
 * How far a point is from a player's body — an upright cylinder, feet to
 * head — in simulation units; 0 inside it.
 */
export function distanceToBody(body, p, height) {
    const across = Math.max(0, Math.hypot(body.x - p.x, body.y - p.y) - PLAYER_HALF);
    const up = Math.max(0, body.z - p.z, p.z - (body.z + height));
    return Math.hypot(across, up);
}
