/**
 * Earth Wall's numbers, payloads and placement rule. Shared code: the
 * frontend imports this file too, so it must stay pure — no imports beyond
 * shared constants and types.
 */
import { ARENA_WIDTH, ARENA_HEIGHT, PLAYER_HALF } from "../../shared/constants.js";
/**
 * Earth Wall (earth): raise a wall of rock at a point on the ground, across
 * the line from you to it. It stands `lifetimeMs`, blocking players and
 * projectiles alike — and while it stands, casting again blows it up: every
 * other player close to it is hurt, and the wall is gone. It can't be blown
 * up the moment it rises: there is always a beat to see it coming.
 */
export const EARTH_WALL = {
    cooldownMs: 14_000,
    /** How long it stands — and so how long it can be blown up. */
    lifetimeMs: 6000,
    /** From raising it to when it can be blown up. */
    detonateDelayMs: 700,
    /** How far from the caster it can be raised, along the floor. */
    range: 300,
    /** About four bodies long, a little thinner than a body. */
    halfLength: PLAYER_HALF * 4,
    halfThickness: PLAYER_HALF * 0.7,
    /** Taller than anyone jumps (a jump's top of the head is about 80). */
    height: 100,
    /** Blowing it up: to every other living player whose body is within `blastRadius` of the wall. */
    blastDamage: 10,
    blastRadius: PLAYER_HALF * 3,
};
/**
 * Where a wall cast at `target` from `origin` stands: pulled in along the
 * line to within range and inside the arena, turned across that line (along
 * `yaw`'s side when cast right at one's feet). The server raises it there and
 * the caster's client previews the same.
 */
export function placeEarthWall(origin, target, yaw) {
    let dx = target.x - origin.x;
    let dy = target.y - origin.y;
    const distance = Math.hypot(dx, dy);
    if (distance > EARTH_WALL.range) {
        dx *= EARTH_WALL.range / distance;
        dy *= EARTH_WALL.range / distance;
    }
    // Same convention as `stepEntity`: at yaw 0 forward is -y.
    const facing = distance > 1e-6 ? Math.atan2(dy, dx) : Math.atan2(-Math.cos(yaw), -Math.sin(yaw));
    return {
        x: Math.min(ARENA_WIDTH, Math.max(0, origin.x + dx)),
        y: Math.min(ARENA_HEIGHT, Math.max(0, origin.y + dy)),
        angle: facing + Math.PI / 2,
        halfLength: EARTH_WALL.halfLength,
        halfThickness: EARTH_WALL.halfThickness,
        height: EARTH_WALL.height,
    };
}
/** How far a body standing at `p` is from the wall's footprint, edge to edge; 0 touching it. */
export function distanceToWall(wall, p) {
    const dx = p.x - wall.x;
    const dy = p.y - wall.y;
    const cos = Math.cos(wall.angle);
    const sin = Math.sin(wall.angle);
    const u = Math.abs(dx * cos + dy * sin) - wall.halfLength;
    const v = Math.abs(-dx * sin + dy * cos) - wall.halfThickness;
    return Math.max(0, Math.hypot(Math.max(0, u), Math.max(0, v)) - PLAYER_HALF);
}
