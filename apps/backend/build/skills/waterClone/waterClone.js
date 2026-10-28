import { Player } from "../../rooms/schema/MyRoomState.js";
import { SERVER_MESSAGE } from "../../shared/messages.js";
import { hasSkill } from "../../shared/skills.js";
import { ARENA_HEIGHT, ARENA_WIDTH, EYE_HEIGHT, PITCH_LIMIT, PLAYER_HALF, PLAYER_HEIGHT } from "../../shared/constants.js";
import { stepEntity, wrapAngle } from "../../shared/movement.js";
import { lineBlocked, obstacleAt } from "../../shared/obstacles.js";
import { FLAT, groundHeight } from "../../shared/terrain.js";
import { blockedByWalls, canCast, isUntargetable, moveLimits } from "../../effects/effectConfig.js";
import { WATER_CLONE, isWaterClone, } from "./waterCloneConfig.js";
/** Same convention as `stepEntity`: at yaw 0 forward is -y. */
const yawToward = (dx, dy) => Math.atan2(-dx, -dy);
/**
 * Server side of Water Clone: cast validation, the one-at-a-time rule, the
 * cooldown from the clone's end, and every clone's walk and lashes, once per
 * room step. A clone ends when it is killed, when its owner dies or leaves,
 * when its time runs out, and on a fresh round.
 */
export class WaterCloneSkill {
    /**
     * `whip` lashes for the clones; `terrain` is the map's ground they walk on;
     * `onGone` hears of every clone's id once its body has left the state, so
     * the room can drop whatever else it kept on it (effects, other skills' state).
     */
    constructor(room, whip, terrain = FLAT, onGone) {
        this.room = room;
        this.whip = whip;
        this.terrain = terrain;
        this.onGone = onGone;
        /** Per owner: room-clock time (ms) when Water Clone is ready again. */
        this.readyAt = new Map();
        /** Per owner: their clone, while it is out. */
        this.clones = new Map();
        this.nextCloneId = 1;
    }
    /**
     * Sends out a clone just ahead of the caster, if they may: one at a time,
     * and not while cooling down. It goes after the enemy under the aim, else
     * the nearest; with nobody about it waits for someone. Invalid, early or
     * second casts are dropped silently.
     */
    cast(client, message) {
        const ownerId = client.sessionId;
        const caster = this.room.state.players.get(ownerId);
        if (!caster || !this.room.canAct(ownerId) || isWaterClone(caster) || !hasSkill(caster.element, "water_clone")) {
            return;
        }
        const { yaw, pitch } = (message ?? {});
        if (typeof yaw !== "number" || typeof pitch !== "number" || !Number.isFinite(yaw) || !Number.isFinite(pitch)) {
            return;
        }
        if (this.clones.has(ownerId)) {
            return;
        }
        if (this.room.clock.currentTime < (this.readyAt.get(ownerId) ?? 0)) {
            return;
        }
        const at = this.spawnPoint(caster, yaw);
        const targetId = this.targetUnderAim(ownerId, caster, { yaw, pitch }) ?? this.nearestTarget(ownerId, at) ?? "";
        const target = this.room.state.players.get(targetId);
        const id = `clone:${ownerId}:${this.nextCloneId++}`;
        const body = new Player({
            name: caster.name,
            hp: WATER_CLONE.hp,
            element: caster.element,
            ...at, vx: 0, vy: 0, vz: 0,
            // Facing its target from the start; with none, the way the caster looked.
            yaw: target ? yawToward(target.x - at.x, target.y - at.y) : wrapAngle(yaw),
            dashVx: 0, dashVy: 0, dashTime: 0, flightZ: 0, breathing: false, ready: false, wins: 0,
            ownerId,
        });
        this.room.state.players.set(id, body);
        this.clones.set(ownerId, {
            id, ownerId, targetId,
            source: { id: ownerId, name: caster.name, ability: "water_clone" },
            ignore: new Set([ownerId]),
            expiresAt: this.room.clock.currentTime + WATER_CLONE.lifetimeMs,
        });
        this.room.broadcast(SERVER_MESSAGE.waterCloneCast, { casterId: ownerId, cloneId: id, targetId, ...at });
    }
    /**
     * Once per room step, after the players moved: clones whose owner is down,
     * whose own health ran out or whose time is up go; the rest keep after their target —
     * someone else once it is down or out of reach — and lash it when close.
     */
    step(dt) {
        for (const clone of [...this.clones.values()]) {
            const owner = this.room.state.players.get(clone.ownerId);
            const body = this.room.state.players.get(clone.id);
            if (!owner || !this.room.canAct(clone.ownerId)) {
                this.end(clone, "owner");
                continue;
            }
            if (!body || body.hp <= 0) {
                this.end(clone, "killed");
                continue;
            }
            if (this.room.clock.currentTime >= clone.expiresAt) {
                this.end(clone, "expired");
                continue;
            }
            this.drive(clone, body, dt);
        }
    }
    /** The player left: their clone goes, and their cooldown with it. */
    remove(sessionId) {
        const clone = this.clones.get(sessionId);
        if (clone) {
            this.end(clone, "owner");
        }
        this.readyAt.delete(sessionId);
    }
    /** A fresh round: every clone goes, and every cooldown. */
    reset() {
        for (const clone of [...this.clones.values()]) {
            this.end(clone, "reset");
        }
        this.readyAt.clear();
    }
    /** One step of a clone: turn to the target, walk up to it at a mage's pace, lash it once close. */
    drive(clone, body, dt) {
        let target = this.targetable(clone.ownerId, clone.targetId);
        if (!target) {
            clone.targetId = this.nearestTarget(clone.ownerId, body) ?? "";
            target = this.targetable(clone.ownerId, clone.targetId);
        }
        // Frozen or stunned, it neither turns nor lashes; the slow on its legs comes from `moveLimits`.
        const free = canCast(body.effects);
        let yaw = body.yaw;
        let moveY = 0;
        if (target && free) {
            const dx = target.x - body.x;
            const dy = target.y - body.y;
            if (Math.hypot(dx, dy) > 1e-6) {
                yaw = yawToward(dx, dy);
            }
            if (Math.hypot(dx, dy) > WATER_CLONE.stopRange) {
                moveY = -1;
            }
        }
        // The players' own step: the ground, walls, gravity, slows and knockbacks hold it too.
        const walls = blockedByWalls(body.effects) ? this.room.state.walls.values() : [];
        stepEntity(body, { moveX: 0, moveY, yaw, jump: false, breath: false }, dt, moveLimits(body.effects), walls, this.terrain);
        if (!target || !free) {
            return;
        }
        if (Math.hypot(target.x - body.x, target.y - body.y) > WATER_CLONE.attackRange) {
            return;
        }
        if (Math.abs(target.z - body.z) > WATER_CLONE.attackHeight) {
            return;
        }
        // On the whip's own cooldown: most steps this is refused, and that's fine.
        this.whip.attack(clone.id, body, aimAt(body, target), clone.source, clone.ignore, WATER_CLONE.damage);
    }
    /** The clone is gone: its body leaves the state, everyone hears of it, its owner's cooldown starts. */
    end(clone, reason) {
        const body = this.room.state.players.get(clone.id);
        const at = body ? { x: body.x, y: body.y, z: body.z } : { x: 0, y: 0, z: 0 };
        this.clones.delete(clone.ownerId);
        this.whip.remove(clone.id);
        const cooldownMs = reason === "reset" ? 0 : WATER_CLONE.cooldownMs;
        if (cooldownMs > 0) {
            this.readyAt.set(clone.ownerId, this.room.clock.currentTime + cooldownMs);
        }
        this.room.state.players.delete(clone.id);
        this.onGone?.(clone.id);
        this.room.broadcast(SERVER_MESSAGE.waterCloneEnd, {
            casterId: clone.ownerId, cloneId: clone.id, reason, cooldownMs, ...at,
        });
    }
    /** `sessionId` if it is someone `ownerId`'s clone may go after: a living, reachable real player, not the owner. */
    targetable(ownerId, sessionId) {
        if (!sessionId || sessionId === ownerId) {
            return undefined;
        }
        const player = this.room.state.players.get(sessionId);
        if (!player || player.hp <= 0 || isWaterClone(player) || isUntargetable(player.effects)) {
            return undefined;
        }
        return player;
    }
    /** The nearest enemy `ownerId`'s clone may go after, along the floor from `from`. */
    nearestTarget(ownerId, from) {
        let best;
        for (const [sessionId] of this.room.state.players) {
            const player = this.targetable(ownerId, sessionId);
            if (!player) {
                continue;
            }
            const distance = Math.hypot(player.x - from.x, player.y - from.y);
            if (!best || distance < best.distance) {
                best = { id: sessionId, distance };
            }
        }
        return best?.id;
    }
    /**
     * The enemy under the caster's crosshair: the nearest along the view whose
     * body's centre is within `aimRadius` of the aimed line, up to `aimRange`,
     * with no raised wall in between.
     */
    targetUnderAim(ownerId, caster, aim) {
        const pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, aim.pitch));
        const dir = { x: -Math.sin(aim.yaw) * Math.cos(pitch), y: -Math.cos(aim.yaw) * Math.cos(pitch), z: Math.sin(pitch) };
        const eye = { x: caster.x, y: caster.y, z: caster.z + EYE_HEIGHT };
        const walls = [...this.room.state.walls.values()];
        let best;
        for (const [sessionId] of this.room.state.players) {
            const player = this.targetable(ownerId, sessionId);
            if (!player) {
                continue;
            }
            const centre = { x: player.x, y: player.y, z: player.z + PLAYER_HEIGHT / 2 };
            const rx = centre.x - eye.x;
            const ry = centre.y - eye.y;
            const rz = centre.z - eye.z;
            const along = rx * dir.x + ry * dir.y + rz * dir.z;
            if (along <= 0 || along > WATER_CLONE.aimRange || (best && along >= best.along)) {
                continue;
            }
            const off = Math.hypot(rx - dir.x * along, ry - dir.y * along, rz - dir.z * along);
            if (off > WATER_CLONE.aimRadius) {
                continue;
            }
            if (lineBlocked(eye, centre, walls) !== null) {
                continue;
            }
            best = { id: sessionId, along };
        }
        return best?.id;
    }
    /**
     * Just ahead of the caster along the aim, on the ground, inside the arena —
     * or right where the caster stands if a wall is in the way.
     */
    spawnPoint(caster, yaw) {
        const x = Math.min(ARENA_WIDTH - PLAYER_HALF, Math.max(PLAYER_HALF, caster.x - Math.sin(yaw) * WATER_CLONE.spawnDistance));
        const y = Math.min(ARENA_HEIGHT - PLAYER_HALF, Math.max(PLAYER_HALF, caster.y - Math.cos(yaw) * WATER_CLONE.spawnDistance));
        const ahead = { x, y, z: groundHeight(this.terrain, x, y) };
        const walls = [...this.room.state.walls.values()];
        const from = { x: caster.x, y: caster.y, z: caster.z + PLAYER_HEIGHT / 2 };
        const blocked = lineBlocked(from, { ...ahead, z: ahead.z + PLAYER_HEIGHT / 2 }, walls) !== null
            || obstacleAt({ ...ahead, z: ahead.z + PLAYER_HEIGHT / 2 }, PLAYER_HALF, walls) !== undefined;
        return blocked ? { x: caster.x, y: caster.y, z: groundHeight(this.terrain, caster.x, caster.y) } : ahead;
    }
}
/** From a clone's eyes to its target's middle: the aim it lashes along. */
function aimAt(from, target) {
    const dx = target.x - from.x;
    const dy = target.y - from.y;
    const dz = target.z + PLAYER_HEIGHT / 2 - (from.z + EYE_HEIGHT);
    return { yaw: yawToward(dx, dy), pitch: Math.atan2(dz, Math.hypot(dx, dy)) };
}
