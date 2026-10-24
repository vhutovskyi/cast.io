import { SERVER_MESSAGE } from "../../shared/messages.js";
import { hasSkill } from "../../shared/skills.js";
import { seenPlayers } from "../skillRoom.js";
import { WATER_WHIP, WHIP_COMBO, nextWhipStep, whipCooldownMs, whipStrike, } from "./waterWhipConfig.js";
import { launchWhipShard } from "./whipShardConfig.js";
import { WhipShards, whipHit, whipTargets } from "./whipShard.js";
/** Server side of Water Whip: cast validation, cooldowns, the combo, the instant lashes and the shard's flight. */
export class WaterWhipSkill {
    constructor(room) {
        this.room = room;
        /** Per attacker id (a player, or anything else that cracks a whip): their cooldown and combo. */
        this.combos = new Map();
        this.shards = new WhipShards(room);
    }
    /**
     * Validates a player's hit and strikes with it. Invalid or early casts are
     * dropped silently.
     */
    cast(client, message) {
        const caster = this.room.state.players.get(client.sessionId);
        if (!caster || caster.hp <= 0 || !hasSkill(caster.element, "water_whip")) {
            return;
        }
        const { yaw, pitch } = (message ?? {});
        if (typeof yaw !== "number" || typeof pitch !== "number" || !Number.isFinite(yaw) || !Number.isFinite(pitch)) {
            return;
        }
        // Your own Water Clone is never in the way of your lashes.
        const ownClones = new Set();
        for (const [id, player] of this.room.state.players) {
            if (player.ownerId === client.sessionId) {
                ownClones.add(id);
            }
        }
        const source = { id: client.sessionId, name: caster.name, ability: "water_whip" };
        // A lash lands on whoever the caster saw it reach; the shard strikes whoever it would have on their screen.
        this.attack(client.sessionId, caster, { yaw, pitch }, source, ownClones, WATER_WHIP.damage, this.room.lagOf(client.sessionId));
    }
    /**
     * One combo hit from `attackerId` standing at `attacker`, aimed along `aim`, if their whip is ready:
     * its own cooldown and combo step per attacker id. `ignore` are ids it never strikes (besides the attacker); `damage` is what each hit deals.
     * Returns whether it struck (false while on cooldown).
     *
     * `lagMs` is how far behind the attacker saw everyone (a player's `lagOf`;
     * 0, where everyone is now, for anything else): a lash resolves at once
     * against where everyone stood that long ago, and the shard — flying from
     * the next `step` — keeps it for its whole flight. Either way everyone is told (`waterWhipCast`, with
     * `casterId` = `attackerId`, and for the shard `whipShardCast` too).
     */
    attack(attackerId, attacker, aim, source, ignore, damage = WATER_WHIP.damage, lagMs = 0) {
        const now = this.room.clock.currentTime;
        const combo = this.combos.get(attackerId);
        if (combo && now < combo.readyAt) {
            return false;
        }
        const step = nextWhipStep(combo?.last, now);
        const cooldownMs = whipCooldownMs(step);
        this.combos.set(attackerId, { readyAt: now + cooldownMs, last: { step, at: now } });
        const { hand, effect } = WHIP_COMBO[step];
        const cast = { casterId: attackerId, cooldownMs, step, hand };
        if (step === 2) {
            const launch = launchWhipShard(attacker, aim);
            this.room.broadcast(SERVER_MESSAGE.waterWhipCast, { ...cast, end: { x: launch.x, y: launch.y, z: launch.z } });
            this.shards.throw(attackerId, launch, source, ignore, damage, lagMs);
            return true;
        }
        const targets = seenPlayers(whipTargets(this.room.state.players), this.room.seenAgo(lagMs));
        const strike = whipStrike(attackerId, attacker, aim, targets, this.room.state.walls.values(), ignore);
        if (strike.hitId) {
            whipHit(this.room, strike.hitId, damage, effect, source);
        }
        this.room.broadcast(SERVER_MESSAGE.waterWhipCast, { ...cast, ...strike });
        return true;
    }
    /** Flies the shards in the air. */
    step(dt) {
        this.shards.step(dt);
    }
    /** The attacker left: their cooldown and combo go. A shard already in the air still lands. */
    remove(sessionId) {
        this.combos.delete(sessionId);
    }
    /** A fresh round: every cooldown and combo goes, and shards in the air vanish. */
    reset() {
        this.combos.clear();
        this.shards.reset();
    }
}
