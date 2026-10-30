import type { Clock } from "colyseus";
import type { MyRoomState, Player } from "../rooms/schema/MyRoomState.js";
import { ARENA_WIDTH, ARENA_HEIGHT } from "../shared/constants.js";
import { clearForcedMotion } from "../shared/movement.js";
import { groundHeight, type Terrain } from "../shared/terrain.js";

/**
 * The slice of the arena room a game mode may touch, like `SkillRoom` is for
 * skills: the mode decides the rules, the room owns the simulation.
 */
export interface ModeRoom {
  readonly state: MyRoomState;
  /** The room clock: phases and delays run on it, never on wall time. */
  readonly clock: Clock;
  /** The map's ground, fixed for the room's life: spawns stand on it. */
  readonly terrain: Terrain;
  /**
   * Everyone back to full health, with no status effects, cooldowns,
   * projectiles or ground fire left over — and clients told to match.
   * Where they stand is the mode's job: `place` each player after.
   */
  resetArena(): void;
}

/**
 * The rules of one room: who goes where, what a death means, when the fight
 * is on. `MyRoom` runs the same simulation for every mode and asks its mode
 * at each of these points.
 */
export interface GameMode {
  /** False while hits don't count (a duel between rounds): damage is ignored. */
  readonly canDamage: boolean;

  /** A player took a seat: place them. Called before they enter the state. */
  join(sessionId: string, player: Player): void;
  /** A player is gone for good (not a dropped connection still being held). */
  leave(sessionId: string): void;
  /** A player's health just reached 0. */
  died(sessionId: string): void;
  /** The Respawn button. */
  respawn(sessionId: string): void;
  /** The Ready button. */
  ready(sessionId: string): void;
  /** Once per room step, after the simulation: phases, round results. */
  step(): void;
  /** A player's connection dropped; their seat is held for `graceMs` while they try to come back. */
  drop?(sessionId: string, graceMs: number): void;
  /** A dropped player is back in their seat. */
  reconnect?(sessionId: string): void;
}

/** Puts a player at rest on the ground at (x, y), facing the arena centre. */
export function placeFacingCentre(player: Player, x: number, y: number, terrain: Terrain) {
  player.x = x;
  player.y = y;
  player.z = groundHeight(terrain, x, y);
  player.vx = 0;
  player.vy = 0;
  player.vz = 0;
  clearForcedMotion(player);
  // Same convention as `stepEntity`: at yaw 0 forward is -y.
  player.yaw = Math.atan2(x - ARENA_WIDTH / 2, y - ARENA_HEIGHT / 2);
}
