/**
 * Water Whip's numbers, combo, payloads and lash rule. Shared code: the frontend
 * imports this file too, so it must stay pure — no imports beyond shared constants and types.
 */
import { EYE_HEIGHT, PITCH_LIMIT, PLAYER_HALF, PLAYER_HEIGHT } from "../../shared/constants.js";
import { lineBlocked } from "../../shared/obstacles.js";
/**
 * Water Whip (water's main skill): a three-hit combo cracked out along the
 * view, one hit per click. The two lashes — right hand, then left — land at
 * once on the nearest enemy inside a narrow cone ahead (forgiving, since
 * others are drawn a little in the past) and only on them; the third throws
 * a shard of ice from between the eyes that flies to its target
 * (`whipShardConfig`). Each hit slows a little. The shard ends the combo
 * with the longer `comboResetMs` wait; a pause of more than that since the
 * last hit starts the combo over too.
 */
export const WATER_WHIP = {
    /** Every hit: each lash and the shard. */
    damage: 7,
    /** Between hits within the combo. */
    cooldownMs: 400,
    /**
     * After the shard, the combo's last hit: the wait before it starts over.
     * Also the longest pause between hits that keeps the combo going.
     */
    comboResetMs: 1400,
    /** How far a lash reaches, from the caster's centre to a body's edge, along the floor. */
    range: 210,
    /** Sideways: how far off the view's heading a body's centre may be. */
    halfAngleDeg: 18,
    /** Up and down: how far above or below a body the aimed line may pass and still hit. */
    verticalReach: 14,
};
/** The combo's hits, in order: which hand each leaves from, and the slow it puts on whoever it strikes. */
export const WHIP_COMBO = [
    { hand: "right", effect: "whip_slow_10" },
    { hand: "left", effect: "whip_slow_15" },
    { hand: "center", effect: "whip_slow_10" },
];
/**
 * The one combo rule: which hit comes next after `last` (none yet: the
 * first), `now` on the same clock. Too long a pause starts it over; after
 * the shard it starts over too. The server runs it for the real hit; the
 * caster's client runs it to draw the right one on the click.
 */
export function nextWhipStep(last, now) {
    if (!last || now - last.at > WATER_WHIP.comboResetMs) {
        return 0;
    }
    return ((last.step + 1) % WHIP_COMBO.length);
}
/** The wait after hit `step`: the usual cooldown, or the longer combo reset once the shard ends it. */
export function whipCooldownMs(step) {
    return step === WHIP_COMBO.length - 1 ? WATER_WHIP.comboResetMs : WATER_WHIP.cooldownMs;
}
const COS_HALF_ANGLE = Math.cos((WATER_WHIP.halfAngleDeg * Math.PI) / 180);
/** A body right on top of the caster has no direction: it is struck. */
const EPSILON = 1e-6;
/**
 * The one lash rule: from the caster's eyes along the view, the nearest
 * living body other than the caster's, and none of `ignore`, whose centre is within the cone along
 * the floor and whose height the aimed line passes close enough to. Same
 * convention as `stepEntity`: at yaw 0 forward is -y. Pitch is clamped like
 * the camera's. A raised wall in the way shields whoever is behind it, and
 * a lash that hits nobody cracks against it. The server runs it for the
 * real hit; the caster's client runs it to draw the lash on the click.
 */
export function whipStrike(casterId, caster, aim, players, obstacles = [], ignore) {
    const walls = [...obstacles];
    const pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, aim.pitch));
    const slope = Math.tan(pitch);
    const forwardX = -Math.sin(aim.yaw);
    const forwardY = -Math.cos(aim.yaw);
    const eye = caster.z + EYE_HEIGHT;
    let best;
    for (const [id, target] of players) {
        if (id === casterId || target.hp <= 0 || ignore?.has(id)) {
            continue;
        }
        const dx = target.x - caster.x;
        const dy = target.y - caster.y;
        const distance = Math.hypot(dx, dy);
        if (distance > WATER_WHIP.range + PLAYER_HALF) {
            continue;
        }
        if (distance > EPSILON && (dx * forwardX + dy * forwardY) / distance < COS_HALF_ANGLE) {
            continue;
        }
        // Where the aimed line is at the body, clamped onto it: the lash's tip.
        const height = eye + slope * distance;
        if (height < target.z - WATER_WHIP.verticalReach || height > target.z + PLAYER_HEIGHT + WATER_WHIP.verticalReach) {
            continue;
        }
        if (!best || distance < best.distance) {
            const z = Math.min(target.z + PLAYER_HEIGHT, Math.max(target.z, height));
            const at = { x: target.x, y: target.y, z };
            if (lineBlocked({ x: caster.x, y: caster.y, z: eye }, at, walls) !== null) {
                continue;
            }
            best = { id, distance, at };
        }
    }
    if (best) {
        return { hitId: best.id, end: best.at };
    }
    // A miss cracks at full reach along the view, never below the floor — or
    // against a wall in the way.
    const reach = Math.cos(pitch) * WATER_WHIP.range;
    const start = { x: caster.x, y: caster.y, z: eye };
    const end = {
        x: caster.x + forwardX * reach,
        y: caster.y + forwardY * reach,
        z: Math.max(0, eye + Math.sin(pitch) * WATER_WHIP.range),
    };
    const blocked = lineBlocked(start, end, walls);
    if (blocked === null) {
        return { end };
    }
    return {
        end: {
            x: start.x + (end.x - start.x) * blocked,
            y: start.y + (end.y - start.y) * blocked,
            z: start.z + (end.z - start.z) * blocked,
        },
    };
}
