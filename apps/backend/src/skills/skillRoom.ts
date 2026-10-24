import type { Clock } from "colyseus";
import type { MyRoomState, Player } from "../rooms/schema/MyRoomState.js";
import type { DamageOptions, DamageSource } from "../shared/combat.js";
import type { EffectId } from "../effects/effectConfig.js";
import type { GroundZoneSpec } from "../effects/groundZones.js";

/**
 * What the room does with every skill's server logic, whatever it is: a
 * player leaving, a fresh round, and — for skills with something in flight —
 * one step of the simulation. Casting stays skill-specific (its own message).
 */
export interface ServerSkill {
  /** The player left: their cooldowns (and anything only they drive) go. */
  remove(sessionId: string): void;
  /** A fresh round: every cooldown goes, and nothing cast before lands. */
  reset(): void;
  /** Advances whatever is in flight by `dt` seconds. */
  step?(dt: number): void;
  /**
   * Right after one of `sessionId`'s inputs moved them: whatever runs on the
   * caster's own movement steps (a phase that ends after so many of them), so
   * it ends on the very step their client predicted.
   */
  afterInput?(sessionId: string, player: Player): void;
}

/**
 * The slice of the arena room a skill's server logic may touch. Skills get
 * this rather than the whole room, so what they can reach stays explicit.
 */
export interface SkillRoom {
  readonly state: MyRoomState;
  /** The room clock: cooldowns and delays run on it, never on wall time. */
  readonly clock: Clock;
  /** To everyone in the room. */
  broadcast(type: string, message: unknown): void;
  /** To one player, if still connected. */
  send(sessionId: string, type: string, message: unknown): void;
  /**
   * `MyRoom.damage()`: the only way health goes down. A hit with a `source`
   * also applies that ability's on-hit effects (`ABILITY_EFFECTS`).
   */
  damage(sessionId: string, amount: number, source?: DamageSource, options?: DamageOptions): void;
  /**
   * Puts a status effect on a living player — for `durationMs`, or the
   * effect's own duration — never cutting what's left of it short. False if
   * there is none to apply it to.
   */
  applyEffect(sessionId: string, id: EffectId, source?: DamageSource, durationMs?: number): boolean;
  /** Takes a status effect off a player before it wears off; nothing if they don't have it. */
  removeEffect(sessionId: string, id: EffectId): void;
  /** Lays a ground zone that applies effects to whoever stands in it; returns its id. */
  addGroundZone(zone: GroundZoneSpec): number;
  /**
   * Lag compensation: where everyone stood on `sessionId`'s screen when they
   * acted. Others are drawn a little in the past there, so a hit that resolves
   * at once is judged on what the caster saw, not where everyone has moved on
   * to. `atInput` reads it as of their last applied input (a skill their
   * inputs drive: Flame Breath); else as of the newest input received (a cast
   * message, which follows it). Where everyone is now while that's unknown.
   */
  seenBy(sessionId: string, atInput?: boolean): SeenAt;
  /**
   * How far behind the room's clock `sessionId` saw everyone just now, in ms
   * (as `seenBy`; 0 while unknown, never more than the room's rewind window).
   * Something they throw keeps it for its whole flight: read the world through
   * `seenAgo(lag)` at each of its hit tests, and it strikes whatever it would
   * have struck on the thrower's screen.
   */
  lagOf(sessionId: string, atInput?: boolean): number;
  /** Everyone where they stood `lagMs` ago (a thrower's `lagOf`); 0 is where everyone is now. */
  seenAgo(lagMs: number): SeenAt;
}

/** A point in the arena, in simulation units. */
export interface SeenPoint { x: number; y: number; z: number; }

/** Where a player stood as someone saw them. Positions only: the rest of a player reads live. */
export type SeenAt = (player: Player) => SeenPoint;

/** Everyone where they are now: no compensation (a server-driven attack, a test). */
export const LIVE: SeenAt = (player) => player;

/** `players` as a hit test reads them: alive or not as they are now, standing where `seen` has them. */
export function* seenPlayers(players: Iterable<[string, Player]>, seen: SeenAt): Iterable<[string, SeenPoint & { hp: number }]> {
  for (const [id, player] of players) {
    const { x, y, z } = seen(player);
    yield [id, { x, y, z, hp: player.hp }];
  }
}
