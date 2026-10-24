import type { Client } from "colyseus";
import { PLAYER_HEIGHT } from "../../shared/constants.js";
import { SERVER_MESSAGE } from "../../shared/messages.js";
import type { DamageSource } from "../../shared/combat.js";
import { hasSkill } from "../../shared/skills.js";
import { lineBlocked, obstacleAt } from "../../shared/obstacles.js";
import type { SkillRoom } from "../skillRoom.js";
import {
  FIREBALL, distanceToBody, fireballPosition, fireballStepFrom, fireballSurfaceBurst, launchFireball,
  type FireballAim, type FireballCast, type FireballHit, type FireballLaunch, type FireballPoint,
} from "./fireballConfig.js";

/**
 * A fireball in flight. Server-only: clients fly their own copy from the
 * `fireballCast` launch, so nothing here is synced — its position is always
 * `fireballPosition(launch, ageMs)`.
 */
interface Flight {
  id: number;
  launch: FireballLaunch;
  /** Session id of the caster. */
  ownerId: string;
  ageMs: number;
  source: DamageSource;
  /** How far behind (ms) the caster saw everyone when they threw it: it strikes them where they were then. */
  lag: number;
}

/** Server side of Fireball: cast validation, cooldowns, flight and blasts. */
export class FireballSkill {
  /** Per caster: room-clock time (ms) when the next fireball is ready. */
  private readyAt = new Map<string, number>();
  private nextFireballId = 1;
  /** Every fireball in the air, by id. */
  private flights = new Map<number, Flight>();

  constructor(private readonly room: SkillRoom) {}

  /**
   * Validates and launches a fireball from the caster's right hand along
   * their view. Invalid or early casts are dropped silently.
   */
  cast(client: Client, message: unknown) {
    const caster = this.room.state.players.get(client.sessionId);
    if (!caster || caster.hp <= 0 || !hasSkill(caster.element, "fireball")) { return; }

    const { yaw, pitch } = (message ?? {}) as Partial<FireballAim>;
    if (typeof yaw !== "number" || typeof pitch !== "number" || !Number.isFinite(yaw) || !Number.isFinite(pitch)) { return; }

    const now = this.room.clock.currentTime;
    if (now < (this.readyAt.get(client.sessionId) ?? 0)) { return; }
    this.readyAt.set(client.sessionId, now + FIREBALL.cooldownMs);

    const launch = launchFireball(caster, { yaw, pitch });
    const id = this.nextFireballId++;
    this.flights.set(id, {
      id,
      launch,
      ownerId: client.sessionId,
      ageMs: 0,
      source: { id: client.sessionId, name: caster.name, ability: "fireball" },
      lag: this.room.lagOf(client.sessionId),
    });

    this.room.broadcast(SERVER_MESSAGE.fireballCast, {
      id, casterId: client.sessionId, cooldownMs: FIREBALL.cooldownMs, ...launch,
    } satisfies FireballCast);
  }

  /** A fireball already in the air still lands; only the cooldown goes. */
  remove(sessionId: string) {
    this.readyAt.delete(sessionId);
  }

  /** A fresh round: every cooldown goes, and fireballs in the air vanish. */
  reset() {
    this.readyAt.clear();
    this.flights.clear();
  }

  /**
   * Flies every fireball one tick along its arc, in sub-steps short enough
   * that one can't skip through a player between ticks. It blows up on the
   * first thing it touches — a living player other than the caster, a wall
   * or the floor — or quietly burns out at the end of its lifetime.
   */
  step(dt: number) {
    const finished: number[] = [];

    for (const [id, flight] of this.flights) {
      const from = flight.ageMs / 1000;
      const substeps = Math.ceil(dt / fireballStepFrom(from, dt));
      let burst = false;
      for (let i = 1; i <= substeps && !burst; i++) {
        burst = this.burst(flight, fireballPosition(flight.launch, from + (dt * i) / substeps));
      }
      flight.ageMs += dt * 1000;
      if (burst || flight.ageMs >= FIREBALL.lifetimeMs) { finished.push(id); }
    }

    for (const id of finished) { this.flights.delete(id); }
  }

  /**
   * Blows the fireball up here if it touches anything; false if it flies on.
   * Bodies stand where the caster's screen had them (`flight.lag` behind);
   * walls, health and the damage itself are live.
   */
  private burst(flight: Flight, at: FireballPoint): boolean {
    const seen = this.room.seenAgo(flight.lag);
    const touchesBody = [...this.room.state.players].some(([sessionId, player]) =>
      sessionId !== flight.ownerId && player.hp > 0
      && distanceToBody(seen(player), at, PLAYER_HEIGHT) <= FIREBALL.radius);
    const walls = [...this.room.state.walls.values()];
    const point = fireballSurfaceBurst(at) ?? (touchesBody || obstacleAt(at, FIREBALL.radius, walls) ? at : null);
    if (!point) { return false; }

    // Everyone the blast reaches but the caster, the one it touched included —
    // except behind a wall, which takes the blast for them.
    const hits: string[] = [];
    for (const [sessionId, player] of this.room.state.players) {
      if (sessionId === flight.ownerId || player.hp <= 0) { continue; }
      const body = seen(player);
      if (distanceToBody(body, point, PLAYER_HEIGHT) > FIREBALL.blastRadius) { continue; }
      const middle = { x: body.x, y: body.y, z: body.z + PLAYER_HEIGHT / 2 };
      if (!touchesBody && lineBlocked(point, middle, walls) !== null) { continue; }
      hits.push(sessionId);
    }
    for (const sessionId of hits) { this.room.damage(sessionId, FIREBALL.damage, flight.source); }

    this.room.broadcast(SERVER_MESSAGE.fireballHit, { id: flight.id, ...point, hits } satisfies FireballHit);
    return true;
  }
}
