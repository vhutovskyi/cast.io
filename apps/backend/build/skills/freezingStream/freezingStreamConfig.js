/**
 * Freezing Stream's numbers, payloads and path. Shared code: the frontend
 * imports this file too, so it must stay pure — no imports beyond shared constants and types.
 */
import { ARENA_WIDTH, ARENA_HEIGHT, EYE_HEIGHT, PITCH_LIMIT, PLAYER_HALF, PLAYER_HEIGHT } from "../../shared/constants.js";
import { obstacleAt } from "../../shared/obstacles.js";
/**
 * Freezing Stream (water's ultimate), after Sub-Zero's ice blast: a fast,
 * narrow jet of icy water fired from the right hand along the view. Its head
 * races out in a straight line — fast, but it can be seen coming and side-
 * stepped — and the first living enemy it touches takes the hit and is frozen
 * solid (`frozen`: no walking, jumping or casting). A wall, the floor or the
 * end of its reach stops it harmlessly.
 */
export const FREEZING_STREAM = {
    /** To the one body the head strikes. */
    damage: 15,
    /** How long the victim stays frozen. */
    freezeMs: 2500,
    cooldownMs: 30_000,
    /** How fast the head travels, in simulation units per second: full reach in 0.6 s. */
    speed: 800,
    /** How far the head goes before it runs out, along its line, in simulation units. */
    range: 480,
    /** The head's radius: it strikes bodies, walls and the floor within this of its centre. */
    radius: 8,
    /** Launch point: this far to the caster's right of their eyes. */
    handOffset: 10,
};
/** How long a stream takes to reach its full range, in ms. */
export const FREEZING_STREAM_TRAVEL_MS = (FREEZING_STREAM.range / FREEZING_STREAM.speed) * 1000;
/**
 * The one launch rule: from the right hand beside the eyes, along the view.
 * Same convention as `stepEntity`: at yaw 0 forward is -y and right is +x.
 * Pitch tilts it up or down, clamped like the camera's.
 */
export function launchFreezingStream(caster, aim) {
    const tilt = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, aim.pitch));
    const sin = Math.sin(aim.yaw);
    const cos = Math.cos(aim.yaw);
    const flat = Math.cos(tilt);
    return {
        x: caster.x + cos * FREEZING_STREAM.handOffset,
        y: caster.y - sin * FREEZING_STREAM.handOffset,
        z: caster.z + EYE_HEIGHT,
        dx: -sin * flat,
        dy: -cos * flat,
        dz: Math.sin(tilt),
    };
}
/** Where the head of a stream launched like this is once it has come `distance` units. */
export function freezingStreamPosition(launch, distance) {
    return {
        x: launch.x + launch.dx * distance,
        y: launch.y + launch.dy * distance,
        z: launch.z + launch.dz * distance,
    };
}
/**
 * If a head here touches a wall or the floor, the point it stops at —
 * against the surface, not past it; otherwise null.
 */
export function freezingStreamSurfaceStop(p) {
    const r = FREEZING_STREAM.radius;
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
function distanceToBody(body, p) {
    const across = Math.max(0, Math.hypot(body.x - p.x, body.y - p.y) - PLAYER_HALF);
    const up = Math.max(0, body.z - p.z, p.z - (body.z + PLAYER_HEIGHT));
    return Math.hypot(across, up);
}
/**
 * The one hit rule: sweeps the head from `from` to `to` units along its line
 * (never past its range) in steps no longer than its radius, so it can't skip
 * through a body or a wall, and returns where it stops on that stretch — on
 * the first living body other than the caster's it touches (the nearest one,
 * if it touches several at once), on a wall, a raised obstacle or the floor,
 * or at the end of its reach — or null if it flies on. The server runs it
 * every step; the caster's client runs it with `players` empty for the aim preview.
 */
export function sweepFreezingStream(launch, from, to, casterId, players, obstacles = []) {
    const end = Math.min(to, FREEZING_STREAM.range);
    const walls = [...obstacles];
    const bodies = [...players].filter(([id, target]) => id !== casterId && target.ownerId !== casterId && target.hp > 0);
    const samples = Math.max(1, Math.ceil((end - from) / FREEZING_STREAM.radius));
    for (let i = 1; i <= samples; i++) {
        const distance = from + ((end - from) * i) / samples;
        const at = freezingStreamPosition(launch, distance);
        let best;
        for (const [id, target] of bodies) {
            const gap = distanceToBody(target, at);
            if (gap <= FREEZING_STREAM.radius && (!best || gap < best.gap)) {
                best = { id, gap };
            }
        }
        if (best) {
            return { distance, at, hitId: best.id };
        }
        const surface = freezingStreamSurfaceStop(at);
        if (surface) {
            return { distance, at: surface };
        }
        if (obstacleAt(at, FREEZING_STREAM.radius, walls)) {
            return { distance, at };
        }
    }
    return end >= FREEZING_STREAM.range ? { distance: end, at: freezingStreamPosition(launch, end) } : null;
}
/**
 * Where a stream launched like this stops if no one is in the way: a wall,
 * the floor, or the end of its reach. The end of the caster's aim line.
 */
export function freezingStreamReach(launch, obstacles = []) {
    return sweepFreezingStream(launch, 0, FREEZING_STREAM.range, "", [], obstacles);
}
