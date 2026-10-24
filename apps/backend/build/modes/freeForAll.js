import { ARENA_WIDTH, ARENA_HEIGHT, MAX_HP, RESPAWN_DELAY_MS } from "../shared/constants.js";
import { placeFacingCentre } from "./gameMode.js";
/** Free-for-all: everyone against everyone, always on; the dead respawn when they choose. */
export class FreeForAllMode {
    constructor(room) {
        this.room = room;
        this.canDamage = true;
        this.spawnCount = 0;
        /** Per dead player: room-clock time (ms) of death, for the respawn delay. */
        this.diedAt = new Map();
        room.state.match.mode = "ffa";
        room.state.match.phase = "playing";
    }
    join(_sessionId, player) {
        this.placeAtSpawn(player);
    }
    leave(sessionId) {
        this.diedAt.delete(sessionId);
    }
    died(sessionId) {
        this.diedAt.set(sessionId, this.room.clock.currentTime);
    }
    /** Only works once dead for `RESPAWN_DELAY_MS`. */
    respawn(sessionId) {
        const player = this.room.state.players.get(sessionId);
        const diedAt = this.diedAt.get(sessionId);
        if (!player || player.hp > 0 || diedAt === undefined) {
            return;
        }
        if (this.room.clock.currentTime < diedAt + RESPAWN_DELAY_MS) {
            return;
        }
        this.diedAt.delete(sessionId);
        player.hp = MAX_HP;
        this.placeAtSpawn(player);
    }
    ready() { }
    step() { }
    /** Deterministic spawn ring, so players never start on top of each other. */
    placeAtSpawn(player) {
        const angle = this.spawnCount++ * 2.399963;
        placeFacingCentre(player, ARENA_WIDTH / 2 + Math.cos(angle) * 80, ARENA_HEIGHT / 2 + Math.sin(angle) * 80, this.room.terrain);
    }
}
