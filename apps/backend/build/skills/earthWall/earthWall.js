import { Wall } from "../../rooms/schema/MyRoomState.js";
import { SERVER_MESSAGE } from "../../shared/messages.js";
import { hasSkill } from "../../shared/skills.js";
import { EARTH_WALL, distanceToWall, placeEarthWall, } from "./earthWallConfig.js";
/** The plain shape of a synced wall, for messages. */
function shapeOf(wall) {
    const { x, y, angle, halfLength, halfThickness, height } = wall;
    return { x, y, angle, halfLength, halfThickness, height };
}
/**
 * Server side of Earth Wall: cast validation, cooldowns, raising the wall in
 * the synced `state.walls` (where movement, projectiles and lines of sight
 * meet it), bringing it down after its lifetime, and blowing it up.
 */
export class EarthWallSkill {
    constructor(room) {
        this.room = room;
        /** Per caster: room-clock time (ms) when Earth Wall is ready again. */
        this.readyAt = new Map();
        /** Per caster: their wall, while it stands. */
        this.standing = new Map();
        this.nextWallId = 1;
    }
    /**
     * Validates and raises a wall at the target, pulled into range, across the
     * line from the caster. Anyone it comes up on is pushed out of it by their
     * next step — physics on live bodies, so no rewinding here. Invalid or
     * early casts are dropped silently.
     */
    cast(client, message) {
        const caster = this.room.state.players.get(client.sessionId);
        if (!caster || caster.hp <= 0 || !hasSkill(caster.element, "earth_wall")) {
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
        this.readyAt.set(client.sessionId, now + EARTH_WALL.cooldownMs);
        // The cooldown outlasts a wall, so there is never an old one left; just in case.
        this.bringDown(client.sessionId);
        const shape = placeEarthWall(caster, { x, y }, caster.yaw);
        const id = `earth-${this.nextWallId++}`;
        this.room.state.walls.set(id, new Wall({ ownerId: client.sessionId, kind: "wall", ...shape }));
        this.standing.set(client.sessionId, {
            id,
            detonateAt: now + EARTH_WALL.detonateDelayMs,
            crumble: this.room.clock.setTimeout(() => this.bringDown(client.sessionId), EARTH_WALL.lifetimeMs),
            source: { id: client.sessionId, name: caster.name, ability: "earth_wall" },
        });
        client.send(SERVER_MESSAGE.earthWallRaised, {
            id, wall: shape, cooldownMs: EARTH_WALL.cooldownMs, lifetimeMs: EARTH_WALL.lifetimeMs, detonateDelayMs: EARTH_WALL.detonateDelayMs,
        });
    }
    /**
     * The second cast: blows the caster's standing wall up, hurting every other
     * living player close to it. Nothing standing, or raised too recently
     * (`detonateDelayMs`), nothing happens. The dead can't, and neither can
     * the frozen or stunned (the room checks that).
     */
    detonate(client) {
        const caster = this.room.state.players.get(client.sessionId);
        const standing = this.standing.get(client.sessionId);
        if (!caster || caster.hp <= 0 || !standing) {
            return;
        }
        if (this.room.clock.currentTime < standing.detonateAt) {
            return;
        }
        const wall = this.room.state.walls.get(standing.id);
        if (!wall) {
            return;
        }
        const shape = shapeOf(wall);
        this.bringDown(client.sessionId);
        // Caught are those the caster saw close to the wall; the wall itself stands where it stands.
        const seen = this.room.seenBy(client.sessionId);
        const hits = [];
        for (const [sessionId, player] of this.room.state.players) {
            if (sessionId === client.sessionId || player.hp <= 0) {
                continue;
            }
            if (distanceToWall(shape, seen(player)) > EARTH_WALL.blastRadius) {
                continue;
            }
            hits.push(sessionId);
        }
        for (const sessionId of hits) {
            this.room.damage(sessionId, EARTH_WALL.blastDamage, standing.source);
        }
        this.room.broadcast(SERVER_MESSAGE.earthWallBlast, { id: standing.id, wall: shape, hits });
    }
    /** The player left: their cooldown goes; a wall of theirs stands out its time. */
    remove(sessionId) {
        this.readyAt.delete(sessionId);
    }
    /** A fresh round: every cooldown goes, and every wall comes down. */
    reset() {
        this.readyAt.clear();
        for (const sessionId of [...this.standing.keys()]) {
            this.bringDown(sessionId);
        }
    }
    /** Takes a caster's wall out of the arena, if it is still standing. */
    bringDown(sessionId) {
        const standing = this.standing.get(sessionId);
        if (!standing) {
            return;
        }
        standing.crumble.clear();
        this.standing.delete(sessionId);
        this.room.state.walls.delete(standing.id);
    }
}
