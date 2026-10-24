import { PLAYER_HEIGHT } from "../../shared/constants.js";
import { SERVER_MESSAGE } from "../../shared/messages.js";
import { hasSkill } from "../../shared/skills.js";
import { STONE_SKIN } from "./stoneSkinConfig.js";
/**
 * Server side of Stone Skin: cast validation, cooldowns, the effect on the
 * caster, and the hurt it does to enemies who touch them while it lasts.
 */
export class StoneSkinSkill {
    constructor(room) {
        this.room = room;
        /** Per caster: room-clock time (ms) when Stone Skin is ready again. */
        this.readyAt = new Map();
        /** Per caster hardened right now. */
        this.hardened = new Map();
    }
    /** Hardens the caster, if they may. Early casts are dropped silently; there is no payload to check. */
    cast(client) {
        const caster = this.room.state.players.get(client.sessionId);
        if (!caster || caster.hp <= 0 || !hasSkill(caster.element, "stone_skin")) {
            return;
        }
        const now = this.room.clock.currentTime;
        if (now < (this.readyAt.get(client.sessionId) ?? 0)) {
            return;
        }
        this.readyAt.set(client.sessionId, now + STONE_SKIN.cooldownMs);
        const source = { id: client.sessionId, name: caster.name, ability: "stone_skin" };
        this.room.applyEffect(client.sessionId, "stone_skin", source);
        this.hardened.set(client.sessionId, { until: now + STONE_SKIN.durationMs, touched: new Set(), source });
        this.room.broadcast(SERVER_MESSAGE.stoneSkinCast, { casterId: client.sessionId, cooldownMs: STONE_SKIN.cooldownMs });
    }
    /**
     * Once per room step: every living enemy now touching a hardened caster —
     * bodies overlapping along the floor and in height — is hurt, once per
     * hardening. Skins that wore off, or whose caster died or left, go.
     */
    step() {
        const now = this.room.clock.currentTime;
        for (const [casterId, skin] of this.hardened) {
            const caster = this.room.state.players.get(casterId);
            if (!caster || caster.hp <= 0 || now >= skin.until) {
                this.hardened.delete(casterId);
                continue;
            }
            for (const [sessionId, player] of this.room.state.players) {
                if (sessionId === casterId || player.hp <= 0 || skin.touched.has(sessionId)) {
                    continue;
                }
                if (Math.hypot(player.x - caster.x, player.y - caster.y) > STONE_SKIN.contactDistance) {
                    continue;
                }
                if (Math.abs(player.z - caster.z) >= PLAYER_HEIGHT) {
                    continue;
                }
                skin.touched.add(sessionId);
                this.room.damage(sessionId, STONE_SKIN.contactDamage, skin.source);
                this.room.broadcast(SERVER_MESSAGE.stoneSkinContact, { casterId, victimId: sessionId });
            }
        }
    }
    /** The player left: their cooldown and their skin go. */
    remove(sessionId) {
        this.readyAt.delete(sessionId);
        this.hardened.delete(sessionId);
    }
    /** A fresh round: every cooldown and skin goes (the room clears the effect itself). */
    reset() {
        this.readyAt.clear();
        this.hardened.clear();
    }
}
