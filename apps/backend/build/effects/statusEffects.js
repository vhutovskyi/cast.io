import { EFFECTS, ABILITY_EFFECTS } from "./effectConfig.js";
/**
 * Server side of status effects: who has what, until when. Effect ids are
 * server config, never wire data, so an unknown id is a bug and throws.
 * The ids on each player are mirrored to `Player.effects` for the clients.
 */
export class StatusEffects {
    constructor(room, defs = EFFECTS, abilityEffects = ABILITY_EFFECTS) {
        this.room = room;
        this.defs = defs;
        this.abilityEffects = abilityEffects;
        /** Per player: their active effects by id. */
        this.active = new Map();
        for (const [id, def] of Object.entries(defs)) {
            if (!(def.durationMs > 0)) {
                throw new Error(`Effect "${id}" needs a positive durationMs.`);
            }
            if (def.tick && !(def.tick.everyMs > 0)) {
                throw new Error(`Effect "${id}" needs a positive tick.everyMs.`);
            }
        }
        for (const ids of Object.values(abilityEffects)) {
            ids.forEach((id) => this.assertDefined(id));
        }
    }
    assertDefined(id) {
        if (!Object.hasOwn(this.defs, id)) {
            throw new Error(`Unknown status effect "${id}".`);
        }
    }
    /**
     * Puts an effect on a living player for `durationMs` (the effect's own by
     * default), or restarts its timer if they already have it — never cutting
     * what is left short (the damage beat keeps going). False if there is no
     * one to apply it to.
     */
    apply(sessionId, id, source, durationMs) {
        this.assertDefined(id);
        const player = this.room.state.players.get(sessionId);
        if (!player || player.hp <= 0) {
            return false;
        }
        const def = this.defs[id];
        const now = this.room.clock.currentTime;
        const expiresAt = now + (durationMs !== undefined && durationMs > 0 ? durationMs : def.durationMs);
        let effects = this.active.get(sessionId);
        if (!effects) {
            effects = new Map();
            this.active.set(sessionId, effects);
        }
        const current = effects.get(id);
        if (current) {
            current.expiresAt = Math.max(current.expiresAt, expiresAt);
            current.source = source;
        }
        else {
            effects.set(id, { expiresAt, nextTickAt: now + (def.tick?.everyMs ?? Infinity), source });
            player.effects.push(id);
        }
        return true;
    }
    /** A hit by `source` landed on this player: applies that ability's on-hit effects. */
    applyOnHit(sessionId, source) {
        for (const id of this.abilityEffects[source.ability] ?? []) {
            this.apply(sessionId, id, source);
        }
    }
    has(sessionId, id) {
        return this.active.get(sessionId)?.has(id) ?? false;
    }
    /** What every hit on this player is multiplied by, from all their effects. */
    damageTakenScale(sessionId) {
        let scale = 1;
        for (const id of this.active.get(sessionId)?.keys() ?? []) {
            scale *= this.defs[id].damageTakenScale ?? 1;
        }
        return scale;
    }
    remove(sessionId, id) {
        const effects = this.active.get(sessionId);
        if (!effects?.delete(id)) {
            return;
        }
        if (effects.size === 0) {
            this.active.delete(sessionId);
        }
        const player = this.room.state.players.get(sessionId);
        const index = player?.effects.indexOf(id) ?? -1;
        if (index >= 0) {
            player.effects.splice(index, 1);
        }
    }
    /** Death or leaving: every effect goes. */
    clear(sessionId) {
        this.active.delete(sessionId);
        this.room.state.players.get(sessionId)?.effects.clear();
    }
    /** A fresh round: every effect on everyone goes. */
    clearAll() {
        for (const sessionId of this.room.state.players.keys()) {
            this.clear(sessionId);
        }
        this.active.clear();
    }
    /**
     * Once per room step: lands the damage ticks that are due — up to the
     * effect's end, so a stalled room catches up but never overshoots — then
     * lets the effects that ran out wear off.
     */
    step() {
        const now = this.room.clock.currentTime;
        for (const [sessionId, effects] of this.active) {
            for (const [id, effect] of effects) {
                const { tick } = this.defs[id];
                const until = Math.min(now, effect.expiresAt);
                // A tick can kill, which clears every effect: stop once this one is gone.
                while (tick && effect.nextTickAt <= until && effects.get(id) === effect) {
                    effect.nextTickAt += tick.everyMs;
                    this.room.damage(sessionId, tick.damage, effect.source, { fromEffect: true });
                }
                if (effects.get(id) === effect && now >= effect.expiresAt) {
                    this.remove(sessionId, id);
                }
            }
        }
    }
}
