import type { Client } from "colyseus";
import { SERVER_MESSAGE } from "../../shared/messages.js";
import type { DamageSource } from "../../shared/combat.js";
import { hasSkill } from "../../shared/skills.js";
import { obstacleAt } from "../../shared/obstacles.js";
import { seenPlayers, type SkillRoom, type ServerSkill } from "../skillRoom.js";
import {
  STONE_FISTS, fistPosition, fistStepFrom, fistStruck, fistSurfaceHit, launchFist, otherSide,
  type FistLaunch, type FistPoint, type FistSide, type StoneFistHit, type StoneFistPunched, type StonesAim,
} from "./stonesConfig.js";

/**
 * A fist in flight. Server-only: clients fly their own copy from the
 * `stoneFistPunched` launch, so nothing here is synced — its position is
 * always `fistPosition(launch, ageMs)`.
 */
interface Flight {
  id: number;
  launch: FistLaunch;
  /** Session id of the caster. */
  ownerId: string;
  /** How far behind the caster saw everyone when they punched (`lagOf`): it strikes whoever it reaches on their screen. */
  lag: number;
  ageMs: number;
  source: DamageSource;
}

/** One caster's fists: which punches next, and when it may. */
interface Fists {
  next: FistSide;
  /** Room-clock time (ms) when the next punch may go. */
  punchAt: number;
}

/** Server side of Stone Fists: punching, which hand, the time between punches, flight and the strike. */
export class StonesSkill implements ServerSkill {
  /** Per caster who has punched this round; anyone missing punches right first, right away. */
  private fists = new Map<string, Fists>();
  private nextFistId = 1;
  /** Every fist in the air, by id. */
  private flights = new Map<number, Flight>();

  constructor(private readonly room: SkillRoom) {}

  /**
   * Validates a click and punches the caster's next fist along their facing;
   * the server alone says which hand, so everyone draws the same one.
   * Invalid or early clicks are dropped silently.
   */
  cast(client: Client, message: unknown) {
    const caster = this.room.state.players.get(client.sessionId);
    if (!caster || !this.room.canAct(client.sessionId) || !hasSkill(caster.element, "stones")) { return; }

    const { yaw } = (message ?? {}) as Partial<StonesAim>;
    if (typeof yaw !== "number" || !Number.isFinite(yaw)) { return; }

    const now = this.room.clock.currentTime;
    const fists = this.fists.get(client.sessionId) ?? { next: "right", punchAt: 0 };
    if (now < fists.punchAt) { return; }
    const side = fists.next;
    this.fists.set(client.sessionId, { next: otherSide(side), punchAt: now + STONE_FISTS.punchIntervalMs });

    const launch = launchFist(caster, { yaw }, side);
    const id = this.nextFistId++;
    this.flights.set(id, {
      id,
      launch,
      ownerId: client.sessionId,
      lag: this.room.lagOf(client.sessionId),
      ageMs: 0,
      source: { id: client.sessionId, name: caster.name, ability: "stones" },
    });

    this.room.broadcast(SERVER_MESSAGE.stoneFistPunched, {
      id, casterId: client.sessionId, side, cooldownMs: STONE_FISTS.punchIntervalMs, ...launch,
    } satisfies StoneFistPunched);
  }

  /** Fists already in the air still land; which hand is next, and the wait, go. */
  remove(sessionId: string) {
    this.fists.delete(sessionId);
  }

  /** A fresh round: everyone punches right first, right away, and fists in the air vanish. */
  reset() {
    this.fists.clear();
    this.flights.clear();
  }

  /**
   * Flies every fist one tick along its path, in sub-steps short enough that
   * one can't skip through a player between ticks. It breaks on the first
   * thing it touches — a living player other than the caster, an arena wall,
   * the floor or a raised wall — or quietly crumbles at the end of its reach.
   */
  step(dt: number) {
    const finished: number[] = [];
    for (const [id, flight] of this.flights) {
      const from = flight.ageMs / 1000;
      // Never past the end of its reach, however the ticks fall: a punch is short, so a tick over shows.
      const span = Math.max(0, Math.min(dt, STONE_FISTS.lifetimeMs / 1000 - from));
      const substeps = Math.ceil(span / fistStepFrom());
      let broke = false;
      for (let i = 1; i <= substeps && !broke; i++) {
        broke = this.break(flight, fistPosition(flight.launch, from + (span * i) / substeps));
      }
      flight.ageMs += dt * 1000;
      if (broke || flight.ageMs >= STONE_FISTS.lifetimeMs - 1e-6) { finished.push(id); }
    }

    for (const id of finished) { this.flights.delete(id); }
  }

  /**
   * Breaks the fist here if it touches anything; false if it flies on. A
   * body comes before the surface it stands against: whoever it grazed on
   * the way into a wall still takes it. Bodies stand where the caster saw
   * them; walls, the floor and the damage are now.
   */
  private break(flight: Flight, at: FistPoint): boolean {
    const hitId = fistStruck(flight.ownerId, at, seenPlayers(this.room.state.players, this.room.seenAgo(flight.lag)));
    const point = hitId ? at : fistSurfaceHit(at) ?? (obstacleAt(at, STONE_FISTS.radius, this.room.state.walls.values()) ? at : null);
    if (!point) { return false; }

    if (hitId) { this.room.damage(hitId, STONE_FISTS.damage, flight.source); }

    this.room.broadcast(SERVER_MESSAGE.stoneFistHit, { id: flight.id, ...point, ...(hitId && { hitId }) } satisfies StoneFistHit);
    return true;
  }
}
