import { PLAYER_HALF, PLAYER_HEIGHT, EYE_HEIGHT } from "../../shared/constants.js";
import { SERVER_MESSAGE } from "../../shared/messages.js";
import { hasSkill } from "../../shared/skills.js";
import { lineBlocked } from "../../shared/obstacles.js";
import { FLAME_BREATH } from "./flameBreathConfig.js";
/** Channel time is a sum of float steps: compare with a little slack. */
const EPSILON = 1e-6;
/**
 * How far the room clock may run ahead of a channel's input time before the
 * channel is cut anyway — a caster whose inputs stopped arriving mid-breath
 * must not stay "breathing" for everyone else forever.
 */
const STALL_GRACE_MS = 1000;
const COS_HALF_ANGLE = Math.cos((FLAME_BREATH.halfAngleDeg * Math.PI) / 180);
/**
 * Server side of Flame Breath. Breathing arrives as an input flag, so the
 * channel advances one input at a time, in step with movement: `vet` decides
 * before each step whether the flag stands, `advance` runs the channel after.
 */
export class FlameBreathSkill {
    constructor(room) {
        this.room = room;
        /** Per caster: room-clock time (ms) when Flame Breath is ready again. */
        this.readyAt = new Map();
        this.channels = new Map();
    }
    /**
     * The command to step a living player with: their input as received, but
     * `breath` only if they may breathe right now — Flame Breath in their kit,
     * `mayCast` (not frozen), off cooldown, breath left in this channel. Never
     * trust the wire. A refused breath ends a channel in progress.
     */
    vet(sessionId, player, input, mayCast) {
        // Decoded inputs keep their fields on the prototype: name them, don't spread.
        const breath = input.breath === true && mayCast && this.canBreathe(sessionId, player);
        return { moveX: input.moveX, moveY: input.moveY, yaw: input.yaw, jump: input.jump, breath };
    }
    /**
     * After one input's step: starts, burns or ends the caster's channel.
     * `breath` is the vetted flag that step ran with.
     */
    advance(sessionId, player, breath, dt) {
        let channel = this.channels.get(sessionId);
        if (!breath) {
            if (channel) {
                this.end(sessionId, player);
            }
            return;
        }
        if (!channel) {
            channel = {
                elapsedMs: 0,
                nextBurnMs: 0,
                startedAt: this.room.clock.currentTime,
                source: { id: sessionId, name: player.name, ability: "flame_breath" },
            };
            this.channels.set(sessionId, channel);
            player.breathing = true;
        }
        // The first burn lands the moment the breath starts, then every tickMs.
        if (channel.elapsedMs >= channel.nextBurnMs - EPSILON) {
            this.burn(sessionId, player, channel.source);
            channel.nextBurnMs += FLAME_BREATH.tickMs;
        }
        channel.elapsedMs += dt * 1000;
        if (channel.elapsedMs >= FLAME_BREATH.maxChannelMs - EPSILON) {
            this.end(sessionId, player);
        }
    }
    /**
     * Once per room step, after the inputs: ends a channel no input will — the
     * caster died since their last one, or their inputs stopped arriving.
     */
    settle(sessionId, player) {
        const channel = this.channels.get(sessionId);
        if (!channel) {
            return;
        }
        const stalled = this.room.clock.currentTime > channel.startedAt + FLAME_BREATH.maxChannelMs + STALL_GRACE_MS;
        if (!this.room.canAct(sessionId) || stalled) {
            this.end(sessionId, player);
        }
    }
    /** The player left: their channel and cooldown go with them. */
    remove(sessionId) {
        this.channels.delete(sessionId);
        this.readyAt.delete(sessionId);
    }
    /** A fresh round: every channel is cut without a cooldown, and every cooldown goes. */
    reset() {
        for (const sessionId of this.channels.keys()) {
            const player = this.room.state.players.get(sessionId);
            if (player) {
                player.breathing = false;
            }
        }
        this.channels.clear();
        this.readyAt.clear();
    }
    canBreathe(sessionId, player) {
        if (!this.room.canAct(sessionId) || !hasSkill(player.element, "flame_breath")) {
            return false;
        }
        if (this.room.clock.currentTime < (this.readyAt.get(sessionId) ?? 0)) {
            return false;
        }
        const channel = this.channels.get(sessionId);
        return !channel || channel.elapsedMs < FLAME_BREATH.maxChannelMs - EPSILON;
    }
    /**
     * Stops the flames and starts the cooldown. The caster's client counts its
     * own cooldown from this message's arrival — a little behind the server's —
     * so it never sends a breath that would be refused.
     */
    end(sessionId, player) {
        this.channels.delete(sessionId);
        player.breathing = false;
        this.readyAt.set(sessionId, this.room.clock.currentTime + FLAME_BREATH.cooldownMs);
        this.room.send(sessionId, SERVER_MESSAGE.flameBreathEnd, { cooldownMs: FLAME_BREATH.cooldownMs });
    }
    /**
     * One burn: damages every living player but the caster inside the cone —
     * within range of the caster's centre (plus a body's half-width), within
     * the half-angle of their facing, and at a height the level flames reach.
     */
    burn(casterId, caster, source) {
        // Same convention as `stepEntity`: at yaw 0 forward is -y.
        const forwardX = -Math.sin(caster.yaw);
        const forwardY = -Math.cos(caster.yaw);
        const eye = caster.z + EYE_HEIGHT;
        const walls = [...this.room.state.walls.values()];
        // Burns whoever the caster saw in the flames when they sent the breath that ran this step.
        const seen = this.room.seenBy(casterId, true);
        for (const [sessionId, player] of this.room.state.players) {
            if (sessionId === casterId || player.hp <= 0) {
                continue;
            }
            const target = seen(player);
            const dx = target.x - caster.x;
            const dy = target.y - caster.y;
            const distance = Math.hypot(dx, dy);
            if (distance > FLAME_BREATH.range + PLAYER_HALF) {
                continue;
            }
            // A body right on top of the caster has no direction: it burns.
            if (distance > EPSILON && (dx * forwardX + dy * forwardY) / distance < COS_HALF_ANGLE) {
                continue;
            }
            if (target.z + PLAYER_HEIGHT < eye - FLAME_BREATH.verticalReach || target.z > eye + FLAME_BREATH.verticalReach) {
                continue;
            }
            // A raised wall takes the flames for whoever is behind it.
            const at = { x: target.x, y: target.y, z: Math.min(target.z + PLAYER_HEIGHT, Math.max(target.z, eye)) };
            if (lineBlocked({ x: caster.x, y: caster.y, z: eye }, at, walls) !== null) {
                continue;
            }
            this.room.damage(sessionId, FLAME_BREATH.tickDamage, source);
        }
    }
}
