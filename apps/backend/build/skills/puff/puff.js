import { SERVER_MESSAGE } from "../../shared/messages.js";
import { hasSkill } from "../../shared/skills.js";
import { PUFF, PUFF_REACH } from "./puffConfig.js";
/** Server side of Puff: cast validation, cooldowns, the burst, the knockbacks and the caster's boost. */
export class PuffSkill {
    constructor(room) {
        this.room = room;
        /** Per caster: room-clock time (ms) when Puff is ready again. */
        this.readyAt = new Map();
    }
    /**
     * Bursts at once around the caster, if they may. Every living enemy within
     * reach — along the floor, and not far above or below — is hurt, and the
     * survivors are blown straight away from the caster; the caster's boost
     * starts (or starts over) either way. There is no payload to check; early
     * casts are dropped silently.
     */
    cast(client, _message) {
        const caster = this.room.state.players.get(client.sessionId);
        if (!caster || !this.room.canAct(client.sessionId) || !hasSkill(caster.element, "puff")) {
            return;
        }
        const now = this.room.clock.currentTime;
        if (now < (this.readyAt.get(client.sessionId) ?? 0)) {
            return;
        }
        this.readyAt.set(client.sessionId, now + PUFF.cooldownMs);
        const source = { id: client.sessionId, name: caster.name, ability: "puff" };
        const hits = [];
        // Caught are those the caster saw within reach, and blown away from the caster as they saw it.
        const seen = this.room.seenBy(client.sessionId);
        for (const [sessionId, player] of this.room.state.players) {
            if (sessionId === client.sessionId || player.hp <= 0) {
                continue;
            }
            const at = seen(player);
            const dx = at.x - caster.x;
            const dy = at.y - caster.y;
            const distance = Math.hypot(dx, dy);
            if (distance > PUFF_REACH || Math.abs(at.z - caster.z) > PUFF.heightReach) {
                continue;
            }
            // Standing right on the caster: blown along their facing (at yaw 0 forward is -y).
            const dirX = distance > 0 ? dx / distance : -Math.sin(caster.yaw);
            const dirY = distance > 0 ? dy / distance : -Math.cos(caster.yaw);
            this.room.damage(sessionId, PUFF.damage, source);
            // A killing blow leaves nobody to push: the room has already stopped the dead.
            if (player.hp <= 0) {
                continue;
            }
            player.dashVx = dirX * PUFF.pushSpeed;
            player.dashVy = dirY * PUFF.pushSpeed;
            player.dashTime = PUFF.pushMs / 1000;
            // A hop for the grounded; already rising faster, or flying, they keep that.
            if (player.flightZ <= 0) {
                player.vz = Math.max(player.vz, PUFF.popSpeed);
            }
            hits.push({ id: sessionId, dirX, dirY });
        }
        this.room.applyEffect(client.sessionId, "speed_boost", source);
        this.room.broadcast(SERVER_MESSAGE.puffCast, {
            casterId: client.sessionId, cooldownMs: PUFF.cooldownMs, x: caster.x, y: caster.y, z: caster.z, hits,
        });
    }
    remove(sessionId) {
        this.readyAt.delete(sessionId);
    }
    /** A fresh round: every cooldown goes (the room clears the boost and the slides itself). */
    reset() {
        this.readyAt.clear();
    }
}
