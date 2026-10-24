import type { Client } from "colyseus";
import { SERVER_MESSAGE } from "../../shared/messages.js";
import type { DamageSource } from "../../shared/combat.js";
import { hasSkill } from "../../shared/skills.js";
import { obstacleAt } from "../../shared/obstacles.js";
import { seenPlayers, type SkillRoom, type ServerSkill } from "../skillRoom.js";
import {
  WIND_BLAST_LIFETIME_S, WIND_BLAST_STEP_S, WIND_POLE, launchWindBlast, poleStrike, windBlastPosition, windBlastStruck,
  windBlastSurfaceHit, type WindBlastLaunch, type WindPoleAim, type WindPoleCast, type WindPoleHit, type WindPolePoint,
} from "./windPoleConfig.js";

/**
 * A gust in flight. Server-only: clients fly their own copy from the
 * `windPoleCast` launch, so nothing here is synced — its position is always
 * `windBlastPosition(launch, ageMs)`.
 */
interface Flight {
  id: number;
  launch: WindBlastLaunch;
  /** Session id of the caster. */
  ownerId: string;
  ageMs: number;
  source: DamageSource;
  /** How far behind the caster saw everyone when they swung (`lagOf`): it strikes whoever it reaches on their screen. */
  lag: number;
}

/** Server side of Wind Pole: cast validation, cooldowns, the pole's blow, and gusts in flight. */
export class WindPoleSkill implements ServerSkill {
  /** Per caster: room-clock time (ms) when the next swing is ready. */
  private readyAt = new Map<string, number>();
  private nextBlastId = 1;
  /** Every gust in the air, by id. */
  private flights = new Map<number, Flight>();

  constructor(private readonly room: SkillRoom) {}

  /**
   * Validates a swing: the pole strikes an enemy in reach at once, or else
   * throws a gust along the view. Invalid or early casts are dropped silently.
   */
  cast(client: Client, message: unknown) {
    const caster = this.room.state.players.get(client.sessionId);
    if (!caster || caster.hp <= 0 || !hasSkill(caster.element, "wind_pole")) { return; }

    const { yaw, pitch } = (message ?? {}) as Partial<WindPoleAim>;
    if (typeof yaw !== "number" || typeof pitch !== "number" || !Number.isFinite(yaw) || !Number.isFinite(pitch)) { return; }

    const now = this.room.clock.currentTime;
    if (now < (this.readyAt.get(client.sessionId) ?? 0)) { return; }
    this.readyAt.set(client.sessionId, now + WIND_POLE.cooldownMs);

    const source: DamageSource = { id: client.sessionId, name: caster.name, ability: "wind_pole" };
    // The blow lands on whoever the caster saw in reach; a gust strikes whoever it reaches on their screen.
    const seen = seenPlayers(this.room.state.players, this.room.seenBy(client.sessionId));
    const strike = poleStrike(client.sessionId, caster, yaw, seen, this.room.state.walls.values());
    if (strike) {
      this.room.damage(strike.hitId, WIND_POLE.meleeDamage, source);
      this.room.broadcast(SERVER_MESSAGE.windPoleCast, {
        kind: "strike", casterId: client.sessionId, cooldownMs: WIND_POLE.cooldownMs, strike,
      } satisfies WindPoleCast);
      return;
    }

    const launch = launchWindBlast(caster, { yaw, pitch });
    const id = this.nextBlastId++;
    this.flights.set(id, { id, launch, ownerId: client.sessionId, ageMs: 0, source, lag: this.room.lagOf(client.sessionId) });

    this.room.broadcast(SERVER_MESSAGE.windPoleCast, {
      kind: "blast", id, casterId: client.sessionId, cooldownMs: WIND_POLE.cooldownMs, ...launch,
    } satisfies WindPoleCast);
  }

  /** A gust already in the air still lands; only the cooldown goes. */
  remove(sessionId: string) {
    this.readyAt.delete(sessionId);
  }

  /** A fresh round: every cooldown goes, and gusts in the air vanish. */
  reset() {
    this.readyAt.clear();
    this.flights.clear();
  }

  /**
   * Flies every gust one tick along its line, in sub-steps short enough that
   * one can't skip through a player between ticks. It breaks on the first
   * thing it touches — a living player other than the caster, a wall or the
   * floor — or quietly dies out at the end of its range.
   */
  step(dt: number) {
    const finished: number[] = [];
    const lifetimeMs = WIND_BLAST_LIFETIME_S * 1000;

    for (const [id, flight] of this.flights) {
      const from = flight.ageMs / 1000;
      const substeps = Math.ceil(dt / WIND_BLAST_STEP_S);
      let broke = false;
      for (let i = 1; i <= substeps && !broke; i++) {
        const age = from + (dt * i) / substeps;
        if (age > WIND_BLAST_LIFETIME_S) { break; }
        broke = this.break(flight, windBlastPosition(flight.launch, age));
      }
      flight.ageMs += dt * 1000;
      if (broke || flight.ageMs >= lifetimeMs) { finished.push(id); }
    }

    for (const id of finished) { this.flights.delete(id); }
  }

  /**
   * Breaks the gust here if it touches anything; false if it flies on. A
   * body comes before the surface it stands against: whoever it grazed on
   * the way into a wall still takes it. Bodies stand where the caster saw
   * them (`flight.lag` ago); walls and the floor are where they are now.
   */
  private break(flight: Flight, at: WindPolePoint): boolean {
    const hitId = windBlastStruck(flight.ownerId, at, seenPlayers(this.room.state.players, this.room.seenAgo(flight.lag)));
    const point = hitId ? at : windBlastSurfaceHit(at) ?? (obstacleAt(at, WIND_POLE.radius, this.room.state.walls.values()) ? at : null);
    if (!point) { return false; }

    if (hitId) { this.room.damage(hitId, WIND_POLE.blastDamage, flight.source); }

    this.room.broadcast(SERVER_MESSAGE.windPoleHit, { id: flight.id, ...point, ...(hitId && { hitId }) } satisfies WindPoleHit);
    return true;
  }
}
