import { ARENA_WIDTH, ARENA_HEIGHT } from "../shared/constants.js";
import { DUEL, QUICK_PLAY } from "../shared/gameModes.js";
import { placeFacingCentre } from "./gameMode.js";
import { isWaterClone } from "../skills/waterClone/waterCloneConfig.js";
/**
 * One against one, first to `roundsToWin` rounds. Both players press Ready to
 * start a match — or, with `autoStart` (Quick Play), it starts as soon as both
 * seats are taken; each round starts straight away with both at their spawns,
 * and ends once at most one is standing — both down in the same
 * step is a draw, replayed. Nobody respawns mid-round. A player leaving
 * mid-match forfeits it.
 */
export class DuelMode {
    constructor(room, settings, { autoStart = false, ranked } = {}) {
        this.room = room;
        /** Which spawn each seated player starts rounds at. */
        this.sides = new Map();
        /** Room-clock time (ms) the current timed phase ends. */
        this.phaseEndsAt = 0;
        /** Ranked: the one match has been decided; no other starts. */
        this.over = false;
        /** Ranked: dropped players being waited for, by session id, with the room-clock time (ms) their seat is held until. */
        this.awaiting = new Map();
        this.autoStart = autoStart;
        this.ranked = ranked;
        const { match } = room.state;
        match.mode = "duel";
        match.roundsToWin = settings.roundsToWin;
        match.autoStart = autoStart;
        match.ranked = ranked !== undefined;
        this.setPhase("waiting");
    }
    get phase() {
        return this.room.state.match.phase;
    }
    get canDamage() {
        return this.phase === "fighting" && this.awaiting.size === 0;
    }
    join(sessionId, player) {
        // Whichever spawn is free — the other player may have left and been replaced.
        const side = [...this.sides.values()].includes(0) ? 1 : 0;
        this.sides.set(sessionId, side);
        this.placeAtSpawn(player, side);
    }
    leave(sessionId) {
        this.sides.delete(sessionId);
        this.awaiting.delete(sessionId);
        this.showAwaiting();
        // Ranked: the ranked match decides whether this forfeits, and to whom (`forfeit`).
        if (this.phase === "waiting" || this.ranked) {
            return;
        }
        const [remaining] = this.seated().map(([id]) => id);
        this.endMatch(remaining ?? "");
    }
    /** Round results are decided in `step`, once the whole step's damage is in. */
    died() { }
    /** Nobody respawns in a duel: the next round brings everyone back. */
    respawn() { }
    /** Ranked: pause the fight until they're back. Elsewhere a dropped player just stands there. */
    drop(sessionId, graceMs) {
        if (!this.ranked || this.over) {
            return;
        }
        this.awaiting.set(sessionId, this.room.clock.currentTime + graceMs);
        this.showAwaiting();
    }
    reconnect(sessionId) {
        this.awaiting.delete(sessionId);
        this.showAwaiting();
    }
    /** Ranked: `winnerId` wins the match now, the other having left — even before the first round has begun. */
    forfeit(winnerId) {
        if (!this.ranked || this.over) {
            return;
        }
        this.endMatch(winnerId);
    }
    /** Toggles; once every seat is filled and ready, the match starts. Unused with `autoStart`. */
    ready(sessionId) {
        const player = this.room.state.players.get(sessionId);
        if (!player || this.phase !== "waiting" || this.autoStart) {
            return;
        }
        player.ready = !player.ready;
        const players = this.seated().map(([, p]) => p);
        if (players.length === DUEL.maxClients && players.every((p) => p.ready)) {
            this.startMatch();
        }
    }
    step() {
        const now = this.room.clock.currentTime;
        const { match } = this.room.state;
        if (this.awaiting.size > 0) {
            this.showAwaiting();
        }
        switch (this.phase) {
            case "waiting":
                // Quick Play: no Ready — once the last result has been up long enough, fight whoever is here.
                // Ranked: only ever the one match.
                if (!this.autoStart || this.over || now < this.phaseEndsAt) {
                    break;
                }
                if (this.seated().length === DUEL.maxClients) {
                    this.startMatch();
                }
                else {
                    // Alone: stop showing the old result while waiting for someone new.
                    match.matchWinnerId = "";
                }
                break;
            case "fighting": {
                const standing = this.seated().filter(([, player]) => player.hp > 0);
                if (standing.length > 1) {
                    break;
                }
                const [winnerId, winner] = standing[0] ?? ["", undefined];
                if (winner) {
                    winner.wins++;
                }
                match.roundWinnerId = winnerId;
                this.setPhase("roundOver", DUEL.roundOverMs);
                break;
            }
            case "roundOver":
                if (now < this.phaseEndsAt) {
                    break;
                }
                if (match.roundWinnerId && this.room.state.players.get(match.roundWinnerId).wins >= match.roundsToWin) {
                    this.endMatch(match.roundWinnerId);
                }
                else {
                    this.startRound();
                }
                break;
        }
    }
    startMatch() {
        const { match } = this.room.state;
        match.round = 0;
        match.matchWinnerId = "";
        for (const player of this.room.state.players.values()) {
            player.wins = 0;
            player.ready = false;
        }
        this.startRound();
    }
    startRound() {
        const { match } = this.room.state;
        match.round++;
        match.roundWinnerId = "";
        this.resetArena();
        this.setPhase("fighting");
    }
    /**
     * Back to waiting for Ready, everyone fresh so they can roam meanwhile; the
     * score stays up. With `autoStart`, for `QUICK_PLAY.matchOverMs` before the rematch.
     */
    endMatch(winnerId) {
        this.room.state.match.matchWinnerId = winnerId;
        for (const player of this.room.state.players.values()) {
            player.ready = false;
        }
        this.resetArena();
        this.setPhase("waiting", this.autoStart ? QUICK_PLAY.matchOverMs : 0);
        if (this.ranked) {
            this.over = true;
            this.awaiting.clear();
            this.showAwaiting();
            this.ranked.onMatchEnd(winnerId);
        }
    }
    /** The HUD's "waiting for X to reconnect (12s)": the first of those being waited for. */
    showAwaiting() {
        const { match } = this.room.state;
        const [sessionId, heldUntil] = this.awaiting.entries().next().value ?? ["", 0];
        match.awaitingId = sessionId;
        match.awaitingSeconds = sessionId ? Math.ceil(Math.max(0, heldUntil - this.room.clock.currentTime) / 1000) : 0;
    }
    resetArena() {
        this.room.resetArena();
        for (const [sessionId, player] of this.room.state.players) {
            this.placeAtSpawn(player, this.sides.get(sessionId) ?? 0);
        }
    }
    /** The real players, by session id: a Water Clone is no one's seat, and never stands for a round. */
    seated() {
        return [...this.room.state.players].filter(([, player]) => !isWaterClone(player));
    }
    setPhase(phase, durationMs = 0) {
        this.room.state.match.phase = phase;
        this.phaseEndsAt = this.room.clock.currentTime + durationMs;
    }
    /** Across the arena centre from each other, facing it. */
    placeAtSpawn(player, side) {
        const offset = side === 0 ? -DUEL.spawnOffset : DUEL.spawnOffset;
        placeFacingCentre(player, ARENA_WIDTH / 2 + offset, ARENA_HEIGHT / 2, this.room.terrain);
    }
}
