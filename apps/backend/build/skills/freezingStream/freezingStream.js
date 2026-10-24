import { SERVER_MESSAGE } from "../../shared/messages.js";
import { hasSkill } from "../../shared/skills.js";
import { FREEZING_STREAM, launchFreezingStream, sweepFreezingStream, } from "./freezingStreamConfig.js";
/**
 * `players` as the head's sweep reads them: standing where `seen` has them,
 * alive or not and owned by whoever as they are now.
 */
function* streamTargets(players, seen) {
    for (const [id, player] of players) {
        const { x, y, z } = seen(player);
        yield [id, { x, y, z, hp: player.hp, ownerId: player.ownerId }];
    }
}
/** Server side of Freezing Stream: cast validation, cooldowns, the head's flight, the hit and the freeze. */
export class FreezingStreamSkill {
    constructor(room) {
        this.room = room;
        /** Per caster: room-clock time (ms) when Freezing Stream is ready again. */
        this.readyAt = new Map();
        this.nextStreamId = 1;
        /** Every stream on its way, by id. */
        this.flights = new Map();
    }
    /**
     * Validates and fires a stream from the caster's right hand along their
     * view. Invalid or early casts are dropped silently.
     */
    cast(client, message) {
        const caster = this.room.state.players.get(client.sessionId);
        if (!caster || caster.hp <= 0 || !hasSkill(caster.element, "freezing_stream")) {
            return;
        }
        const { yaw, pitch } = (message ?? {});
        if (typeof yaw !== "number" || typeof pitch !== "number" || !Number.isFinite(yaw) || !Number.isFinite(pitch)) {
            return;
        }
        const now = this.room.clock.currentTime;
        if (now < (this.readyAt.get(client.sessionId) ?? 0)) {
            return;
        }
        this.readyAt.set(client.sessionId, now + FREEZING_STREAM.cooldownMs);
        const launch = launchFreezingStream(caster, { yaw, pitch });
        const id = this.nextStreamId++;
        this.flights.set(id, {
            id,
            launch,
            travelled: 0,
            source: { id: client.sessionId, name: caster.name, ability: "freezing_stream" },
            lag: this.room.lagOf(client.sessionId),
        });
        this.room.broadcast(SERVER_MESSAGE.freezingStreamCast, {
            id, casterId: client.sessionId, cooldownMs: FREEZING_STREAM.cooldownMs, ...launch,
        });
    }
    /** A stream already on its way still lands; only the cooldown goes. */
    remove(sessionId) {
        this.readyAt.delete(sessionId);
    }
    /** A fresh round: every cooldown goes, and streams on their way vanish. */
    reset() {
        this.readyAt.clear();
        this.flights.clear();
    }
    /**
     * Runs every head one tick along its line, in sub-steps no longer than its
     * radius (`sweepFreezingStream`), so it can't skip through a player between
     * ticks. It stops on the first thing it touches — a living player other
     * than the caster, a wall or the floor — or at the end of its reach.
     * Bodies stand where the caster's screen had them (`flight.lag` behind);
     * walls, health and the hit itself are live.
     */
    step(dt) {
        for (const [id, flight] of this.flights) {
            const to = flight.travelled + FREEZING_STREAM.speed * dt;
            const bodies = streamTargets(this.room.state.players, this.room.seenAgo(flight.lag));
            const stop = sweepFreezingStream(flight.launch, flight.travelled, to, flight.source.id, bodies, this.room.state.walls.values());
            flight.travelled = to;
            if (!stop) {
                continue;
            }
            this.flights.delete(id);
            this.land(flight, stop);
        }
    }
    /** Strikes and freezes whoever the head stopped on, if anyone, then tells all clients where it stopped. */
    land(flight, stop) {
        if (stop.hitId) {
            this.room.damage(stop.hitId, FREEZING_STREAM.damage, flight.source);
            // A killing blow leaves nobody to freeze: `applyEffect` skips the dead.
            this.room.applyEffect(stop.hitId, "frozen", flight.source, FREEZING_STREAM.freezeMs);
        }
        this.room.broadcast(SERVER_MESSAGE.freezingStreamHit, {
            id: flight.id, distance: stop.distance, ...stop.at, ...(stop.hitId ? { hitId: stop.hitId } : {}),
        });
    }
}
