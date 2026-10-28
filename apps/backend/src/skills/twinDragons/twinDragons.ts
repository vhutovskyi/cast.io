import type { Client } from "colyseus";
import { PLAYER_HALF } from "../../shared/constants.js";
import { SERVER_MESSAGE } from "../../shared/messages.js";
import type { DamageSource } from "../../shared/combat.js";
import { hasSkill } from "../../shared/skills.js";
import { seenPlayers, type SkillRoom } from "../skillRoom.js";
import {
  TWIN_DRAGONS, TWIN_DRAGONS_SIDES, clampTwinDragonsTarget, twinDragonsPoint,
  type GroundPoint, type TwinDragonsBlast, type TwinDragonsCast, type TwinDragonsHeads, type TwinDragonsLaunch,
} from "./twinDragonsConfig.js";

/** Both streams of one cast, on their way. Server-only: only the caster is told the target. */
interface Flight {
  id: number;
  origin: GroundPoint;
  target: GroundPoint;
  elapsedMs: number;
  source: DamageSource;
  /** How far behind the caster saw everyone when they cast (`lagOf`): heads and blast strike whoever they reach on their screen. */
  lag: number;
  /** Per stream, who its head has already hit: once each. */
  hit: Set<string>[];
  /** Per stream, where it last left fire on the ground. */
  lastFire: GroundPoint[];
}

/** Server side of Twin Dragons: cast validation, cooldowns, the streams, their fire and the blast. */
export class TwinDragonsSkill {
  /** Per caster: room-clock time (ms) when Twin Dragons is ready again. */
  private readyAt = new Map<string, number>();
  private nextFlightId = 1;
  private flights = new Map<number, Flight>();

  constructor(private readonly room: SkillRoom) {}

  /**
   * Validates and launches both streams. Only the caster learns where they
   * will meet; everyone else follows the heads step by step. Invalid or early
   * casts are dropped silently.
   */
  cast(client: Client, message: unknown) {
    const caster = this.room.state.players.get(client.sessionId);
    if (!caster || !this.room.canAct(client.sessionId) || !hasSkill(caster.element, "twin_dragons")) { return; }

    const { x, y } = (message ?? {}) as Partial<TwinDragonsCast>;
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) { return; }

    const now = this.room.clock.currentTime;
    if (now < (this.readyAt.get(client.sessionId) ?? 0)) { return; }
    this.readyAt.set(client.sessionId, now + TWIN_DRAGONS.cooldownMs);

    const id = this.nextFlightId++;
    const origin = { x: caster.x, y: caster.y };
    const target = clampTwinDragonsTarget(origin, { x, y });
    this.flights.set(id, {
      id, origin, target, elapsedMs: 0,
      source: { id: client.sessionId, name: caster.name, ability: "twin_dragons" },
      lag: this.room.lagOf(client.sessionId),
      hit: TWIN_DRAGONS_SIDES.map(() => new Set()),
      lastFire: TWIN_DRAGONS_SIDES.map(() => origin),
    });

    client.send(SERVER_MESSAGE.twinDragonsLaunch, {
      id, origin, target, travelMs: TWIN_DRAGONS.travelMs, cooldownMs: TWIN_DRAGONS.cooldownMs,
    } satisfies TwinDragonsLaunch);
  }

  /** Streams already on their way still land; only the cooldown goes. */
  remove(sessionId: string) {
    this.readyAt.delete(sessionId);
  }

  /** A fresh round: every cooldown goes, and streams on their way vanish. */
  reset() {
    this.readyAt.clear();
    this.flights.clear();
  }

  /**
   * Advances every cast one tick: each stream's head sweeps its stretch of
   * the curve, hitting whoever it touches and leaving fire on the ground, then
   * everyone is told where the heads are; once they meet, the blast.
   */
  step(dt: number) {
    for (const [id, flight] of this.flights) {
      const from = flight.elapsedMs / TWIN_DRAGONS.travelMs;
      flight.elapsedMs += dt * 1000;
      const to = Math.min(1, flight.elapsedMs / TWIN_DRAGONS.travelMs);

      const heads = TWIN_DRAGONS_SIDES.map((side, s) => {
        // Sample often enough that the head can't skip past a body between samples.
        const start = twinDragonsPoint(flight.origin, flight.target, side, from);
        const end = twinDragonsPoint(flight.origin, flight.target, side, to);
        const samples = Math.max(1, Math.ceil(Math.hypot(end.x - start.x, end.y - start.y) / TWIN_DRAGONS.streamRadius));
        for (let i = 1; i <= samples; i++) {
          const at = twinDragonsPoint(flight.origin, flight.target, side, from + ((to - from) * i) / samples);
          this.scorch(flight, s, at);
          this.leaveFire(flight, s, at);
        }
        return end;
      });
      this.room.broadcast(SERVER_MESSAGE.twinDragonsHeads, {
        id, elapsedMs: to * TWIN_DRAGONS.travelMs, heads,
      } satisfies TwinDragonsHeads);

      if (to >= 1) {
        this.flights.delete(id);
        this.blast(flight);
      }
    }
  }

  /** Hits everyone but the caster whose feet are in stream `s`'s head at this point, where the caster saw them — once per stream; the hit adds Burn. */
  private scorch(flight: Flight, s: number, at: GroundPoint) {
    const reach = TWIN_DRAGONS.streamRadius + PLAYER_HALF;
    for (const [sessionId, player] of seenPlayers(this.room.state.players, this.room.seenAgo(flight.lag))) {
      if (sessionId === flight.source.id || flight.hit[s].has(sessionId)) { continue; }
      if (player.hp <= 0 || player.z > TWIN_DRAGONS.streamHeight) { continue; }
      if (Math.hypot(player.x - at.x, player.y - at.y) > reach) { continue; }
      flight.hit[s].add(sessionId);
      this.room.damage(sessionId, TWIN_DRAGONS.streamDamage, flight.source);
    }
  }

  /** Lays a patch of burning ground every stream-width along the path, sparing the caster. */
  private leaveFire(flight: Flight, s: number, at: GroundPoint) {
    const last = flight.lastFire[s];
    if (Math.hypot(at.x - last.x, at.y - last.y) < TWIN_DRAGONS.streamRadius) { return; }
    flight.lastFire[s] = at;
    this.room.addGroundZone({
      ...at, radius: TWIN_DRAGONS.streamRadius, durationMs: TWIN_DRAGONS.trailMs,
      effects: ["burn"], source: flight.source, exemptId: flight.source.id,
    });
  }

  /** Damages everyone but the caster whose body is in the blast, where the caster saw them — the hit adds Burn — then tells all clients. */
  private blast(flight: Flight) {
    const reach = TWIN_DRAGONS.blastRadius + PLAYER_HALF;
    const hits: string[] = [];
    for (const [sessionId, player] of seenPlayers(this.room.state.players, this.room.seenAgo(flight.lag))) {
      if (sessionId === flight.source.id || player.hp <= 0) { continue; }
      if (Math.hypot(player.x - flight.target.x, player.y - flight.target.y) > reach) { continue; }
      this.room.damage(sessionId, TWIN_DRAGONS.damage, flight.source);
      hits.push(sessionId);
    }
    this.room.broadcast(SERVER_MESSAGE.twinDragonsBlast, { id: flight.id, ...flight.target, hits } satisfies TwinDragonsBlast);
  }
}
