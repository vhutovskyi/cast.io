/**
 * The whip shard's flight: Water Whip's third hit. Shared code: the frontend
 * imports this file too, so it must stay pure — no imports beyond shared constants and types.
 */
import { ARENA_WIDTH, ARENA_HEIGHT, EYE_HEIGHT, PITCH_LIMIT, PLAYER_HALF, PLAYER_HEIGHT } from "../../shared/constants.js";
/**
 * The shard of ice the third crack of the whip throws: launched hard from
 * between the eyes along the view, it flies almost straight — a light arc
 * only shows at long range — strikes the first living enemy it touches,
 * alone, and shatters on whatever it meets first: a body, a wall or the
 * floor. Its damage and slow are the whip's (`WATER_WHIP`).
 */
export const WHIP_SHARD = {
    /** Launch speed, in simulation units per second: across the arena in about half a second. */
    speed: 1400,
    /** Pulls the shard down, in units/s² — light, so it barely drops across the arena. */
    gravity: 150,
    /** Hit radius around the shard, in simulation units: what it shatters on touching. */
    radius: 5,
    /** Safety net: thrown at the sky, it melts away after this. */
    lifetimeMs: 1500,
};
/**
 * The one launch rule: from the centre of the eyes — no hand — along the
 * view. The server runs it for the real shard and the caster's client for the
 * one it throws on the click, so both fly the same path. Same convention as
 * `stepEntity`: at yaw 0 forward is -y. Pitch tilts the throw up or down,
 * clamped like the camera's.
 */
export function launchWhipShard(caster, aim) {
    const tilt = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, aim.pitch));
    const flat = Math.cos(tilt) * WHIP_SHARD.speed;
    return {
        x: caster.x,
        y: caster.y,
        z: caster.z + EYE_HEIGHT,
        vx: -Math.sin(aim.yaw) * flat,
        vy: -Math.cos(aim.yaw) * flat,
        vz: Math.sin(tilt) * WHIP_SHARD.speed,
    };
}
/**
 * Where a shard thrown like this is `t` seconds after launch. The server
 * strikes along it, every client draws it — same path everywhere.
 */
export function whipShardPosition(launch, t) {
    return {
        x: launch.x + launch.vx * t,
        y: launch.y + launch.vy * t,
        z: launch.z + launch.vz * t - 0.5 * WHIP_SHARD.gravity * t * t,
    };
}
/** Which way a shard thrown like this is flying `t` seconds after launch (units per second): where its tip points. */
export function whipShardVelocity(launch, t) {
    return { x: launch.vx, y: launch.vy, z: launch.vz - WHIP_SHARD.gravity * t };
}
/**
 * Longest step along the path, in seconds, from `t` that can't carry the
 * shard further than its own radius — so it never skips through a body or a
 * wall. Gravity only ever adds speed, so this bounds it from `t` on.
 */
export function whipShardStepFrom(t, span) {
    const fastest = WHIP_SHARD.speed + WHIP_SHARD.gravity * (t + span);
    return WHIP_SHARD.radius / fastest;
}
/**
 * If a shard here touches an arena wall or the floor, the point it shatters
 * at — against the surface, not past it; otherwise null.
 */
export function whipShardSurfaceHit(p) {
    const r = WHIP_SHARD.radius;
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
 * How far a point is from a player's body — an upright cylinder, feet to
 * head — in simulation units; 0 inside it.
 */
export function distanceToWhipShardTarget(body, p) {
    const across = Math.max(0, Math.hypot(body.x - p.x, body.y - p.y) - PLAYER_HALF);
    const up = Math.max(0, body.z - p.z, p.z - (body.z + PLAYER_HEIGHT));
    return Math.hypot(across, up);
}
/**
 * The one hit rule: the living body other than the thrower's, and none of
 * `ignore`, that a shard here touches — the closest, should it graze two at
 * once — or undefined.
 */
export function whipShardStruck(ownerId, at, players, ignore) {
    let best;
    for (const [id, player] of players) {
        if (id === ownerId || player.hp <= 0 || ignore?.has(id)) {
            continue;
        }
        const distance = distanceToWhipShardTarget(player, at);
        if (distance > WHIP_SHARD.radius) {
            continue;
        }
        if (!best || distance < best.distance) {
            best = { id, distance };
        }
    }
    return best?.id;
}
