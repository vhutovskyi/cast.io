import { ARENA_WIDTH, ARENA_HEIGHT, PLAYER_HALF } from "../../shared/constants.js";
import { SERVER_MESSAGE } from "../../shared/messages.js";
import { hasSkill } from "../../shared/skills.js";
import { SUN_STRIKE } from "./sunStrikeConfig.js";
/** Server side of Sun Strike: cast validation, cooldowns and the landing. */
export class SunStrikeSkill {
    constructor(room) {
        this.room = room;
        /** Per caster: room-clock time (ms) when Sun Strike is ready again. */
        this.readyAt = new Map();
        this.nextStrikeId = 1;
        /** Strikes still charging, by id: their landing timers. */
        this.pending = new Map();
    }
    /**
     * Validates and schedules a Sun Strike. The pending strike lives only in this
     * closure — never in the synced state — so no client but the caster can know
     * it is coming. Invalid or early casts are dropped silently.
     */
    cast(client, message) {
        const caster = this.room.state.players.get(client.sessionId);
        if (!caster || caster.hp <= 0 || !hasSkill(caster.element, "sun_strike")) {
            return;
        }
        const { x, y } = (message ?? {});
        if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
            return;
        }
        const now = this.room.clock.currentTime;
        if (now < (this.readyAt.get(client.sessionId) ?? 0)) {
            return;
        }
        this.readyAt.set(client.sessionId, now + SUN_STRIKE.cooldownMs);
        // Global range, like Invoker's — but always inside the arena.
        const id = this.nextStrikeId++;
        const target = {
            x: Math.min(ARENA_WIDTH, Math.max(0, x)),
            y: Math.min(ARENA_HEIGHT, Math.max(0, y)),
        };
        client.send(SERVER_MESSAGE.sunStrikeCharging, {
            id, ...target, delayMs: SUN_STRIKE.delayMs, cooldownMs: SUN_STRIKE.cooldownMs,
        });
        const source = { id: client.sessionId, name: caster.name, ability: "sun_strike" };
        this.pending.set(id, this.room.clock.setTimeout(() => this.land(id, source, target), SUN_STRIKE.delayMs));
    }
    /** A strike already on its way still lands; only the cooldown goes. */
    remove(sessionId) {
        this.readyAt.delete(sessionId);
    }
    /** A fresh round: every cooldown goes, and strikes still charging never land. */
    reset() {
        this.readyAt.clear();
        this.pending.forEach((landing) => landing.clear());
        this.pending.clear();
    }
    /** Damages every living player but the caster whose body overlaps the beam, then tells all clients. */
    land(id, source, target) {
        this.pending.delete(id);
        const reach = SUN_STRIKE.radius + PLAYER_HALF;
        const hits = [];
        for (const [sessionId, player] of this.room.state.players) {
            if (sessionId === source.id || player.hp <= 0) {
                continue;
            }
            if (Math.hypot(player.x - target.x, player.y - target.y) <= reach) {
                this.room.damage(sessionId, SUN_STRIKE.damage, source);
                hits.push(sessionId);
            }
        }
        this.room.broadcast(SERVER_MESSAGE.sunStrikeHit, { id, ...target, hits });
    }
}
