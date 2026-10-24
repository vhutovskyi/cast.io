import { PLAYER_HALF } from "../../shared/constants.js";
import { SERVER_MESSAGE } from "../../shared/messages.js";
import { hasSkill } from "../../shared/skills.js";
import { INPUT_COOLDOWN_SLACK_MS } from "../../shared/actions.js";
import { seenPlayers } from "../skillRoom.js";
import { SKYFALL, SKYFALL_SOAR_STEPS, skyfallRisen, startSkyfall, startSkyfallDrop, } from "./skyfallConfig.js";
/**
 * Past its soar, how long the room waits for a caster's steps before bringing
 * them down by the clock, in ms: only for one whose inputs stopped arriving.
 */
const STALLED_DROP_MS = 1000;
/**
 * Server side of Skyfall: cast validation, cooldowns, the soaring, the leap
 * down and the landing. The flight itself is the shared movement step's
 * (`flightZ`, then a forced slide under gravity), and the rise, the drop and
 * when it comes run on the caster's own steps, so the caster's client
 * predicts it all; this only sets those fields and watches for the touchdown.
 */
export class SkyfallSkill {
    constructor(room) {
        this.room = room;
        /** Per caster: room-clock time (ms) when Skyfall is ready again. */
        this.readyAt = new Map();
        /** Per caster up in the air, or on the way down. */
        this.flights = new Map();
    }
    /** Launches the caster skyward, if they may. Early casts are dropped silently; there is no payload to check. */
    cast(client, _message) {
        this.rise(client.sessionId, false);
    }
    /**
     * Skyfall pressed in `sessionId`'s input (`INPUT_ACTION.skyfall`), before
     * the step it was pressed on — the step their client predicted it on. A
     * press a hair before the cooldown still counts (`INPUT_COOLDOWN_SLACK_MS`).
     */
    castFromInput(sessionId) {
        this.rise(sessionId, true);
    }
    rise(sessionId, fromInput) {
        const caster = this.room.state.players.get(sessionId);
        if (!caster || caster.hp <= 0 || !hasSkill(caster.element, "skyfall")) {
            return;
        }
        if (this.flights.has(sessionId)) {
            return;
        }
        const now = this.room.clock.currentTime;
        if (now < (this.readyAt.get(sessionId) ?? 0) - (fromInput ? INPUT_COOLDOWN_SLACK_MS : 0)) {
            return;
        }
        this.readyAt.set(sessionId, now + SKYFALL.cooldownMs);
        const source = { id: sessionId, name: caster.name, ability: "skyfall" };
        const height = startSkyfall(caster);
        this.room.applyEffect(sessionId, "soaring", source);
        this.flights.set(sessionId, {
            source, steps: 0, dropBy: now + SKYFALL.soarMs + STALLED_DROP_MS, dropping: false, lag: this.room.lagOf(sessionId, fromInput),
        });
        this.room.broadcast(SERVER_MESSAGE.skyfallRise, {
            casterId: sessionId, x: caster.x, y: caster.y, height, soarMs: SKYFALL.soarMs, cooldownMs: SKYFALL.cooldownMs,
        });
    }
    /**
     * While soaring: drop onto a ground point (pulled into range when it leaps).
     * Chosen while still rising, it waits until they are all the way up. Junk,
     * and a second choice, are dropped silently.
     */
    drop(client, message) {
        const { x, y } = (message ?? {});
        if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
            return;
        }
        this.choose(client.sessionId, { x, y }, false);
    }
    /** The drop chosen in `sessionId`'s input (`INPUT_ACTION.skyfallDrop`), onto its aim. */
    dropFromInput(sessionId, aim) {
        if (!Number.isFinite(aim.x) || !Number.isFinite(aim.y)) {
            return;
        }
        this.choose(sessionId, aim, true);
    }
    choose(sessionId, aim, fromInput) {
        const flight = this.flights.get(sessionId);
        if (!flight || flight.dropping || flight.target) {
            return;
        }
        flight.target = { x: aim.x, y: aim.y };
        flight.lag = this.room.lagOf(sessionId, fromInput);
    }
    /**
     * After each of the caster's steps up there: leaps once they are all the
     * way up and have chosen, or once the soar's steps run out — then straight
     * down where they are. Their client predicts exactly this, step by step.
     */
    afterInput(sessionId, player) {
        const flight = this.flights.get(sessionId);
        if (!flight || flight.dropping || player.hp <= 0) {
            return;
        }
        flight.steps++;
        if ((flight.target && skyfallRisen(player)) || flight.steps >= SKYFALL_SOAR_STEPS) {
            this.leap(sessionId, flight, flight.target ?? player);
        }
    }
    /**
     * Once per room step, after everyone moved: lands whoever touched down, and
     * brings down anyone whose steps stopped coming long past their soar. A
     * caster who died or left just goes: the room already let them fall, and
     * their landing hurts no one.
     */
    step() {
        const now = this.room.clock.currentTime;
        for (const [casterId, flight] of this.flights) {
            const caster = this.room.state.players.get(casterId);
            if (!caster || caster.hp <= 0) {
                this.flights.delete(casterId);
                continue;
            }
            if (!flight.dropping) {
                if (now >= flight.dropBy) {
                    this.leap(casterId, flight, flight.target ?? caster);
                }
                continue;
            }
            if (caster.z <= 0) {
                this.land(casterId, flight, caster);
            }
        }
    }
    /** The player left: their cooldown and their flight go. */
    remove(sessionId) {
        this.readyAt.delete(sessionId);
        this.flights.delete(sessionId);
    }
    /** A fresh round: every cooldown and flight goes (the room clears the motion and the effect itself). */
    reset() {
        this.readyAt.clear();
        this.flights.clear();
    }
    /** From wherever they are now, down onto `aim` pulled into range from the point below them. */
    leap(casterId, flight, aim) {
        const caster = this.room.state.players.get(casterId);
        const from = { fromX: caster.x, fromY: caster.y, fromZ: caster.z };
        const { target, leap } = startSkyfallDrop(caster, aim);
        flight.dropping = true;
        this.room.broadcast(SERVER_MESSAGE.skyfallDrop, {
            casterId, ...target, ...from, durationMs: Math.ceil(leap.dashTime * 1000),
        });
    }
    /**
     * Hurts every living enemy on or near the floor whose body overlaps the
     * shockwave around where the caster really came down (a wall may have cut
     * the slide short), then sends the caster off with a speed boost. Enemies
     * stand where the caster saw them (`flight.lag` ago); the caster's own
     * touchdown, health and everything else are live.
     */
    land(casterId, flight, at) {
        this.flights.delete(casterId);
        this.room.removeEffect(casterId, "soaring");
        const reach = SKYFALL.radius + PLAYER_HALF;
        const hits = [];
        for (const [sessionId, player] of seenPlayers(this.room.state.players, this.room.seenAgo(flight.lag))) {
            if (sessionId === casterId || player.hp <= 0 || player.z > SKYFALL.groundReach) {
                continue;
            }
            if (Math.hypot(player.x - at.x, player.y - at.y) > reach) {
                continue;
            }
            this.room.damage(sessionId, SKYFALL.damage, flight.source);
            hits.push(sessionId);
        }
        this.room.applyEffect(casterId, "speed_boost", flight.source);
        this.room.broadcast(SERVER_MESSAGE.skyfallLand, { casterId, x: at.x, y: at.y, hits });
    }
}
