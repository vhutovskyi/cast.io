import { PLAYER_HALF } from "../shared/constants.js";
import type { DamageSource } from "../shared/combat.js";
import type { SkillRoom } from "../skills/skillRoom.js";
import { isUntargetable, type EffectId } from "./effectConfig.js";
import type { StatusEffects } from "./statusEffects.js";

/**
 * Feet higher than this above the floor are off the ground: a jump clears a
 * zone for as long as it lasts.
 */
export const GROUND_ZONE_HEIGHT = 8;

/** A patch of ground (lava, a frozen puddle, …) that applies effects to whoever stands in it. */
export interface GroundZoneSpec {
  x: number;
  y: number;
  radius: number;
  durationMs: number;
  /** Re-applied every step to each living player inside, so they last while you stand in it. */
  effects: readonly EffectId[];
  /** Credited for the effects' damage; none = nobody's kill. */
  source?: DamageSource;
  /** Never applies to this player — e.g. the caster, in their own fire. */
  exemptId?: string;
}

interface Zone extends GroundZoneSpec {
  /** Room-clock time (ms) it disappears. */
  expiresAt: number;
}

/**
 * Server side of ground zones. Not synced: the skill that creates a zone
 * tells the clients about it (and what it looks like) itself.
 */
export class GroundZones {
  private zones = new Map<number, Zone>();
  private nextZoneId = 1;

  constructor(
    private readonly room: Pick<SkillRoom, "state" | "clock">,
    private readonly effects: Pick<StatusEffects, "apply" | "assertDefined">,
  ) {}

  /** Returns the zone's id. Throws on an unknown effect id. */
  add(spec: GroundZoneSpec): number {
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
        if (sessionId === zone.exemptId || player.hp <= 0 || player.z > GROUND_ZONE_HEIGHT || isUntargetable(player.effects)) { continue; }
        if (Math.hypot(player.x - zone.x, player.y - zone.y) > reach) { continue; }
        for (const effectId of zone.effects) { this.effects.apply(sessionId, effectId, zone.source); }
      }
    }
  }
}
