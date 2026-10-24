import { PLAYER_HALF } from "../shared/constants.js";
import { isUntargetable } from "./effectConfig.js";
/**
 * Feet higher than this above the floor are off the ground: a jump clears a
 * zone for as long as it lasts.
 */
export const GROUND_ZONE_HEIGHT = 8;
/**
 * Server side of ground zones. Not synced: the skill that creates a zone
 * tells the clients about it (and what it looks like) itself.
 */
export class GroundZones {
    constructor(room, effects) {
        this.room = room;
        this.effects = effects;
        this.zones = new Map();
        this.nextZoneId = 1;
    }
    /** Returns the zone's id. Throws on an unknown effect id. */
    add(spec) {
        spec.effects.forEach((id) => this.effects.assertDefined(id));
        const id = this.nextZoneId++;
        this.zones.set(id, { ...spec, expiresAt: this.room.clock.currentTime + spec.durationMs });
        return id;
    }
    /** A fresh round: every zone goes out. */
    clear() {
        this.zones.clear();
    }
    /** Once per room step: drops expired zones, then applies the rest to everyone standing in them. */
    step() {
        const now = this.room.clock.currentTime;
        for (const [id, zone] of this.zones) {
            if (now >= zone.expiresAt) {
                this.zones.delete(id);
                continue;
            }
            const reach = zone.radius + PLAYER_HALF;
            for (const [sessionId, player] of this.room.state.players) {
                // Under the ground (Burrow) nothing on it reaches them.
                if (sessionId === zone.exemptId || player.hp <= 0 || player.z > GROUND_ZONE_HEIGHT || isUntargetable(player.effects)) {
                    continue;
                }
                if (Math.hypot(player.x - zone.x, player.y - zone.y) > reach) {
                    continue;
                }
                for (const effectId of zone.effects) {
                    this.effects.apply(sessionId, effectId, zone.source);
                }
            }
        }
    }
}
