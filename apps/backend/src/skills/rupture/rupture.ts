import type { Client } from "colyseus";
import { PLAYER_HALF } from "../../shared/constants.js";
import { SERVER_MESSAGE } from "../../shared/messages.js";
import type { DamageSource } from "../../shared/combat.js";
import { hasSkill } from "../../shared/skills.js";
import { seenPlayers, type SkillRoom, type ServerSkill } from "../skillRoom.js";
import { RUPTURE, ruptureFront, ruptureReaches, type RuptureAim, type RuptureCast, type RupturePoint } from "./ruptureConfig.js";

/**
 * A wave on its way. Server-only: clients run their own copy of the front
 * from the `ruptureCast`, so nothing here is synced.
 */
interface Wave {
  /** Where the caster stood when it was cast: the wave runs out from there, whatever they do next. */
  origin: RupturePoint;
  yaw: number;
  /** Since the cast, in ms: the front sets off once the wind-up is over. */
  elapsedMs: number;
  /** Everyone already struck: once each. */
  struck: Set<string>;
  source: DamageSource;
  /** How far behind the caster saw everyone when they cast (`lagOf`): the front strikes whoever it reaches on their screen. */
  lag: number;
}

/** Server side of Rupture: cast validation, cooldowns, the front's run across the fan, the hits and the stuns. */
export class RuptureSkill implements ServerSkill {
  /** Per caster: room-clock time (ms) when Rupture is ready again. */
  private readyAt = new Map<string, number>();
  private nextWaveId = 1;
  /** Every wave on its way, by id. */
  private waves = new Map<number, Wave>();

  constructor(private readonly room: SkillRoom) {}

  /**
   * Validates and tears the ground open from the caster's feet along the
   * facing they sent. Invalid or early casts are dropped silently.
   */
  cast(client: Client, message: unknown) {
    const caster = this.room.state.players.get(client.sessionId);
    if (!caster || caster.hp <= 0 || !hasSkill(caster.element, "rupture")) { return; }

    const { yaw } = (message ?? {}) as Partial<RuptureAim>;
    if (typeof yaw !== "number" || !Number.isFinite(yaw)) { return; }

    const now = this.room.clock.currentTime;
    if (now < (this.readyAt.get(client.sessionId) ?? 0)) { return; }
    this.readyAt.set(client.sessionId, now + RUPTURE.cooldownMs);

    const id = this.nextWaveId++;
    const origin = { x: caster.x, y: caster.y };
    this.waves.set(id, {
      origin,
      yaw,
      elapsedMs: 0,
      struck: new Set([client.sessionId]),
      source: { id: client.sessionId, name: caster.name, ability: "rupture" },
      lag: this.room.lagOf(client.sessionId),
    });

    this.room.broadcast(SERVER_MESSAGE.ruptureCast, {
      id, casterId: client.sessionId, cooldownMs: RUPTURE.cooldownMs, ...origin, yaw,
    } satisfies RuptureCast);
  }

  /** A wave already on its way still runs; only the cooldown goes. */
  remove(sessionId: string) {
    this.readyAt.delete(sessionId);
  }

  /** A fresh round: every cooldown goes, and waves on their way vanish. */
  reset() {
    this.readyAt.clear();
    this.waves.clear();
  }

  /**
   * Runs every front one tick further out, once its wind-up is over. Each
   * body the front crosses this tick (`ruptureReaches`) is struck and
   * stunned, once per wave. Past the fan's far edge — and the bodies
   * standing on it — the wave is spent. Bodies stand where the caster saw
   * them (`wave.lag` ago); health, walls and the hits themselves are live.
   */
  step(dt: number) {
    const walls = [...this.room.state.walls.values()];
    for (const [id, wave] of this.waves) {
      const from = ruptureFront(wave.elapsedMs);
      wave.elapsedMs += dt * 1000;
      const to = ruptureFront(wave.elapsedMs);
      if (to <= from) { continue; }
      for (const [sessionId, target] of seenPlayers(this.room.state.players, this.room.seenAgo(wave.lag))) {
        if (wave.struck.has(sessionId) || !ruptureReaches(wave.origin, wave.yaw, from, to, target, walls)) { continue; }
        wave.struck.add(sessionId);
        this.strike(sessionId, wave.source);
      }
      if (to >= RUPTURE.range + PLAYER_HALF) { this.waves.delete(id); }
    }
  }

  private strike(sessionId: string, source: DamageSource) {
    this.room.damage(sessionId, RUPTURE.damage, source);
    // A killing blow leaves nobody to stun: `applyEffect` skips the dead.
    this.room.applyEffect(sessionId, "stunned", source, RUPTURE.stunMs);
  }
}
