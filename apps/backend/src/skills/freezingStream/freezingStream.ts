import type { Client } from "colyseus";
import { SERVER_MESSAGE } from "../../shared/messages.js";
import type { DamageSource } from "../../shared/combat.js";
import { hasSkill } from "../../shared/skills.js";
import type { Player } from "../../rooms/schema/MyRoomState.js";
import type { SeenAt, SkillRoom, ServerSkill } from "../skillRoom.js";
import {
  FREEZING_STREAM, launchFreezingStream, sweepFreezingStream,
  type FreezingStreamAim, type FreezingStreamCast, type FreezingStreamHit, type FreezingStreamLaunch, type FreezingStreamStop,
  type FreezingStreamTarget,
} from "./freezingStreamConfig.js";

/**
 * A stream on its way. Server-only: clients run their own copy of the head
 * from the `freezingStreamCast` launch, so nothing here is synced — the head
 * is always `freezingStreamPosition(launch, travelled)`.
 */
interface Flight {
  id: number;
  launch: FreezingStreamLaunch;
  /** How far the head has come along its line, in simulation units. */
  travelled: number;
  source: DamageSource;
  /** How far behind the caster saw everyone when they fired (`lagOf`): it freezes whoever it reaches on their screen. */
  lag: number;
}

/**
 * `players` as the head's sweep reads them: standing where `seen` has them,
 * alive or not and owned by whoever as they are now.
 */
function* streamTargets(players: Iterable<[string, Player]>, seen: SeenAt): Iterable<[string, FreezingStreamTarget]> {
  for (const [id, player] of players) {
    const { x, y, z } = seen(player);
    yield [id, { x, y, z, hp: player.hp, ownerId: player.ownerId }];
  }
}

/** Server side of Freezing Stream: cast validation, cooldowns, the head's flight, the hit and the freeze. */
export class FreezingStreamSkill implements ServerSkill {
  /** Per caster: room-clock time (ms) when Freezing Stream is ready again. */
  private readyAt = new Map<string, number>();
  private nextStreamId = 1;
  /** Every stream on its way, by id. */
  private flights = new Map<number, Flight>();

  constructor(private readonly room: SkillRoom) {}

  /**
   * Validates and fires a stream from the caster's right hand along their
   * view. Invalid or early casts are dropped silently.
   */
  cast(client: Client, message: unknown) {
    const caster = this.room.state.players.get(client.sessionId);
    if (!caster || caster.hp <= 0 || !hasSkill(caster.element, "freezing_stream")) { return; }

    const { yaw, pitch } = (message ?? {}) as Partial<FreezingStreamAim>;
    if (typeof yaw !== "number" || typeof pitch !== "number" || !Number.isFinite(yaw) || !Number.isFinite(pitch)) { return; }

    const now = this.room.clock.currentTime;
    if (now < (this.readyAt.get(client.sessionId) ?? 0)) { return; }
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
    } satisfies FreezingStreamCast);
  }

  /** A stream already on its way still lands; only the cooldown goes. */
  remove(sessionId: string) {
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
  step(dt: number) {
    for (const [id, flight] of this.flights) {
      const to = flight.travelled + FREEZING_STREAM.speed * dt;
      const bodies = streamTargets(this.room.state.players, this.room.seenAgo(flight.lag));
      const stop = sweepFreezingStream(flight.launch, flight.travelled, to, flight.source.id, bodies, this.room.state.walls.values());
      flight.travelled = to;
      if (!stop) { continue; }
      this.flights.delete(id);
      this.land(flight, stop);
    }
  }

  /** Strikes and freezes whoever the head stopped on, if anyone, then tells all clients where it stopped. */
  private land(flight: Flight, stop: FreezingStreamStop) {
    if (stop.hitId) {
      this.room.damage(stop.hitId, FREEZING_STREAM.damage, flight.source);
      // A killing blow leaves nobody to freeze: `applyEffect` skips the dead.
      this.room.applyEffect(stop.hitId, "frozen", flight.source, FREEZING_STREAM.freezeMs);
    }
    this.room.broadcast(SERVER_MESSAGE.freezingStreamHit, {
      id: flight.id, distance: stop.distance, ...stop.at, ...(stop.hitId ? { hitId: stop.hitId } : {}),
    } satisfies FreezingStreamHit);
  }
}
