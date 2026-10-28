import { PLAYER_HEIGHT } from "../../shared/constants.js";
import { SERVER_MESSAGE } from "../../shared/messages.js";
import { wrapAngle } from "../../shared/movement.js";
import { hasSkill } from "../../shared/skills.js";
import { seenPlayers } from "../skillRoom.js";
import { INPUT_COOLDOWN_SLACK_MS } from "../../shared/actions.js";
import { LEAP, startLeap } from "./leapConfig.js";
/** Distance from `(px, py)` to the segment from `(ax, ay)` to `(bx, by)`. */
function distanceToSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSq = dx * dx + dy * dy;
    const t = lengthSq > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq)) : 0;
    return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}
/**
 * Server side of Leap: cast validation, cooldowns, starting the slide, the
 * hurt it does to enemies it runs into, and the Speed Boost once it ends.
 */
export class LeapSkill {
    constructor(room) {
        this.room = room;
        /** Per caster: room-clock time (ms) when Leap is ready again. */
        this.readyAt = new Map();
        /** Per caster leaping right now. */
        this.leaping = new Map();
    }
    /**
     * Validates and starts the slide along the facing the client sent — the
     * view it pressed the key with, not the synced yaw, which trails behind by
     * the inputs still queued. Invalid or early casts are dropped silently.
     */
    cast(client, message) {
        const { yaw: sent } = (message ?? {});
        if (typeof sent !== "number" || !Number.isFinite(sent)) {
            return;
        }
        this.start(client.sessionId, wrapAngle(sent), false);
    }
    /**
     * A leap pressed in `sessionId`'s input (`INPUT_ACTION.leap`), along that
     * input's facing, before the step it was pressed on — the step their client
     * predicted it on. A press a hair before the cooldown (as counted by the
     * room) still counts: see `INPUT_COOLDOWN_SLACK_MS`.
     */
    castFromInput(sessionId, yaw) {
        this.start(sessionId, yaw, true);
    }
    start(sessionId, yaw, fromInput) {
        const caster = this.room.state.players.get(sessionId);
        if (!caster || !this.room.canAct(sessionId) || !hasSkill(caster.element, "leap")) {
            return;
        }
        const now = this.room.clock.currentTime;
        if (now < (this.readyAt.get(sessionId) ?? 0) - (fromInput ? INPUT_COOLDOWN_SLACK_MS : 0)) {
            return;
        }
        this.readyAt.set(sessionId, now + LEAP.cooldownMs);
        const { vx, vy } = startLeap(caster, yaw);
        this.leaping.set(sessionId, {
            vx, vy, fromX: caster.x, fromY: caster.y, touched: new Set(),
            source: { id: sessionId, name: caster.name, ability: "leap" },
            lag: this.room.lagOf(sessionId, fromInput),
        });
        this.room.broadcast(SERVER_MESSAGE.leapCast, {
            casterId: sessionId, cooldownMs: LEAP.cooldownMs, x: caster.x, y: caster.y, yaw, durationMs: LEAP.durationMs,
        });
    }
    /**
     * Once per room step, after the players moved: every living enemy the
     * caster's path this step came within touching distance of — along the
     * floor and in height — is hurt, once per leap. A slide that ran out (or
     * that something else took over) ends the leap with Speed Boost; a caster
     * who died or left just drops it.
     */
    step() {
        for (const [casterId, leap] of this.leaping) {
            const caster = this.room.state.players.get(casterId);
            if (!caster || !this.room.canAct(casterId)) {
                this.leaping.delete(casterId);
                continue;
            }
            // Another slide set over ours (a knockback) moved them this step, not the leap.
            const takenOver = caster.dashVx !== leap.vx || caster.dashVy !== leap.vy;
            if (!takenOver) {
                this.touch(casterId, caster, leap);
            }
            leap.fromX = caster.x;
            leap.fromY = caster.y;
            if (!takenOver && caster.dashTime > 0) {
                continue;
            }
            this.leaping.delete(casterId);
            this.room.applyEffect(casterId, "speed_boost", leap.source);
        }
    }
    /**
     * Hurts every enemy within touching distance of the caster's path this
     * step, not yet touched this leap. The caster is where they are now (their
     * own client predicts it); enemies stand where the caster saw them
     * (`leap.lag` ago).
     */
    touch(casterId, caster, leap) {
        for (const [sessionId, player] of seenPlayers(this.room.state.players, this.room.seenAgo(leap.lag))) {
            if (sessionId === casterId || player.hp <= 0 || leap.touched.has(sessionId)) {
                continue;
            }
            if (distanceToSegment(player.x, player.y, leap.fromX, leap.fromY, caster.x, caster.y) > LEAP.contactDistance) {
                continue;
            }
            if (Math.abs(player.z - caster.z) >= PLAYER_HEIGHT) {
                continue;
            }
            leap.touched.add(sessionId);
            this.room.damage(sessionId, LEAP.damage, leap.source);
            this.room.broadcast(SERVER_MESSAGE.leapHit, { casterId, victimId: sessionId });
        }
    }
    /** The player left: their cooldown and their leap go (the slide goes with their state). */
    remove(sessionId) {
        this.readyAt.delete(sessionId);
        this.leaping.delete(sessionId);
    }
    /** A fresh round: every cooldown and leap goes (the room clears the slides itself). */
    reset() {
        this.readyAt.clear();
        this.leaping.clear();
    }
}
