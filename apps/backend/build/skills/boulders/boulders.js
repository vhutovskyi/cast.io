import { Wall } from "../../rooms/schema/MyRoomState.js";
import { SERVER_MESSAGE } from "../../shared/messages.js";
import { hasSkill } from "../../shared/skills.js";
import { obstacleAt } from "../../shared/obstacles.js";
import { seenPlayers } from "../skillRoom.js";
import { BOULDERS, boulderArenaHit, boulderPosition, boulderStruck, distanceToBoulder, kickBoulder, placeBoulder, } from "./bouldersConfig.js";
/**
 * Server side of Boulders: raising them into the synced `state.walls` (where
 * movement, projectiles and lines of sight meet them), crumbling them after
 * their lifetime, and kicking them — validation, flight and the strike.
 */
export class BouldersSkill {
    constructor(room) {
        this.room = room;
        /** Per caster: room-clock time (ms) when the next may rise. */
        this.readyAt = new Map();
        /** Every boulder standing, by its id in `state.walls`. */
        this.standing = new Map();
        this.flights = new Map();
        this.nextBoulderId = 1;
    }
    /** Raises a boulder just ahead of the caster, if they may: not too soon, not too many. */
    raise(client) {
        const caster = this.room.state.players.get(client.sessionId);
        if (!caster || caster.hp <= 0 || !hasSkill(caster.element, "boulders")) {
            return;
        }
        const now = this.room.clock.currentTime;
        if (now < (this.readyAt.get(client.sessionId) ?? 0)) {
            return;
        }
        if (this.standingOf(client.sessionId).length >= BOULDERS.maxStanding) {
            return;
        }
        this.readyAt.set(client.sessionId, now + BOULDERS.raiseIntervalMs);
        const id = `boulder-${this.nextBoulderId++}`;
        this.room.state.walls.set(id, new Wall({ ownerId: client.sessionId, kind: "boulder", ...placeBoulder(caster, caster.yaw) }));
        this.standing.set(id, {
            ownerId: client.sessionId,
            crumble: this.room.clock.setTimeout(() => this.takeAway(id), BOULDERS.lifetimeMs),
        });
        client.send(SERVER_MESSAGE.boulderRaised, { id, raiseIntervalMs: BOULDERS.raiseIntervalMs });
    }
    /**
     * Kicks the caster's own boulder they stand at — the nearest, if two —
     * along `yaw`. Nothing in reach, or junk, and nothing happens.
     */
    kick(client, message) {
        const caster = this.room.state.players.get(client.sessionId);
        if (!caster || caster.hp <= 0 || !hasSkill(caster.element, "boulders")) {
            return;
        }
        const { yaw } = (message ?? {});
        if (typeof yaw !== "number" || !Number.isFinite(yaw)) {
            return;
        }
        let nearest;
        for (const id of this.standingOf(client.sessionId)) {
            const boulder = this.room.state.walls.get(id);
            if (!boulder) {
                continue;
            }
            const distance = distanceToBoulder(boulder, caster);
            if (distance > BOULDERS.kickReach + BOULDERS.kickSlack) {
                continue;
            }
            if (!nearest || distance < nearest.distance) {
                nearest = { id, distance };
            }
        }
        if (!nearest) {
            return;
        }
        const launch = kickBoulder(this.room.state.walls.get(nearest.id), yaw);
        this.takeAway(nearest.id);
        this.flights.set(nearest.id, {
            id: nearest.id, launch, ownerId: client.sessionId, lag: this.room.lagOf(client.sessionId), ageMs: 0,
            source: { id: client.sessionId, name: caster.name, ability: "boulders" },
        });
        this.room.broadcast(SERVER_MESSAGE.boulderKicked, { id: nearest.id, casterId: client.sessionId, ...launch });
    }
    /**
     * Flies every kicked boulder one tick along its line, in sub-steps no
     * longer than its radius, so it can't skip through a player or a wall.
     */
    step(dt) {
        const finished = [];
        for (const [id, flight] of this.flights) {
            const from = flight.ageMs / 1000;
            const substeps = Math.ceil((dt * BOULDERS.speed) / BOULDERS.radius);
            let broke = false;
            for (let i = 1; i <= substeps && !broke; i++) {
                broke = this.break(flight, boulderPosition(flight.launch, from + (dt * i) / substeps));
            }
            flight.ageMs += dt * 1000;
            if (broke || flight.ageMs >= BOULDERS.flyLifetimeMs) {
                finished.push(id);
            }
        }
        for (const id of finished) {
            this.flights.delete(id);
        }
    }
    /** The player left: their raise timer goes; their boulders stand out their time. */
    remove(sessionId) {
        this.readyAt.delete(sessionId);
    }
    /** A fresh round: every timer goes, every boulder comes down, kicked ones vanish. */
    reset() {
        this.readyAt.clear();
        for (const id of [...this.standing.keys()]) {
            this.takeAway(id);
        }
        this.flights.clear();
    }
    /** Ids of the boulders `sessionId` has standing. */
    standingOf(sessionId) {
        return [...this.standing].filter(([, boulder]) => boulder.ownerId === sessionId).map(([id]) => id);
    }
    /** Takes a boulder out of the arena, if it is still standing. */
    takeAway(id) {
        const boulder = this.standing.get(id);
        if (!boulder) {
            return;
        }
        boulder.crumble.clear();
        this.standing.delete(id);
        this.room.state.walls.delete(id);
    }
    /**
     * Breaks the kicked boulder here if it touches anyone or anything; false if
     * it flies on. A body comes first. Bodies stand where the kicker saw them;
     * walls and the damage are now.
     */
    break(flight, at) {
        const hitId = boulderStruck(flight.ownerId, at, seenPlayers(this.room.state.players, this.room.seenAgo(flight.lag)));
        const point = hitId ? at : boulderArenaHit(at) ?? (obstacleAt(at, BOULDERS.radius, this.room.state.walls.values()) ? at : null);
        if (!point) {
            return false;
        }
        if (hitId) {
            this.room.damage(hitId, BOULDERS.damage, flight.source);
        }
        this.room.broadcast(SERVER_MESSAGE.boulderHit, { id: flight.id, ...point, ...(hitId && { hitId }) });
        return true;
    }
}
