import { schema, t, type SchemaType } from "@colyseus/schema";

/**
 * One input frame, consumed by `Room.defineInput()`. Flat primitives only, and
 * deliberately minimal:
 *   - no `seq`  — the engine's input counter is the sequence
 *   - no `dt`   — fixed timestep: one input advances exactly one step
 *   - no time   — the SDK stamps lag-comp timing on the wire envelope
 *
 * `int8<-1 | 0 | 1>` narrows the type for your code; the room's `sanitize`
 * clamp is what actually enforces it against a modified client.
 *
 * `moveX` strafes (+1 = right), `moveY` walks (-1 = forward), both relative to
 * `yaw`: the first-person look direction in radians, wrapped to [-π, π].
 * `jump` is the held state of the jump key; it only takes off from the ground.
 * `breath` is "Flame Breath selected and the mouse held"; the room overrides
 * it to false whenever the player may not breathe right now.
 * `act` is a skill that moves the caster, pressed on this step (`INPUT_ACTION`,
 * see `shared/actions.ts`); `aimX`/`aimY` is its ground point, for those that
 * take one (Skyfall's drop).
 */
export const MoveInput = schema({
  moveX: t.int8<-1 | 0 | 1>(),
  moveY: t.int8<-1 | 0 | 1>(),
  yaw: t.float32(),
  jump: t.boolean(),
  breath: t.boolean(),
  act: t.uint8(),
  aimX: t.float32(),
  aimY: t.float32(),
});
export type MoveInput = SchemaType<typeof MoveInput>;

/** `x`/`y` are the ground plane; `z` is height above the floor. */
export const Player = schema({
  name: t.string(),
  /** Server-owned: only `MyRoom.damage()` changes it. 0 = down. */
  hp: t.uint16(),
  /** One of `ELEMENTS`; validated on join. */
  element: t.string(),
  x: t.number(),
  y: t.number(),
  z: t.number(),
  vx: t.number(),
  vy: t.number(),
  vz: t.number(),
  yaw: t.float32(),
  /**
   * Server-owned forced motion (`stepEntity`): while `dashTime` (s) is left,
   * the player slides at (`dashVx`, `dashVy`) whatever they press — a leap,
   * a knockback. Predicted by the client like the rest of the movement.
   */
  dashVx: t.number(),
  dashVy: t.number(),
  dashTime: t.number(),
  /** Server-owned: while above 0, the player rises to and hovers at this height, without gravity. */
  flightZ: t.number(),
  /** Server-owned: channelling Flame Breath right now, for everyone to see. */
  breathing: t.boolean(),
  /** Server-owned: ids of the status effects on the player right now, for the HUD. */
  effects: t.array("string"),
  /** Duel: pressed Ready for the next match. */
  ready: t.boolean(),
  /** Duel: rounds won in the current (or just finished) match. */
  wins: t.uint8(),
  /** Server-owned: "" for a real player; a Water Clone's owner's session id for a clone. */
  ownerId: t.string(),
});
export type Player = SchemaType<typeof Player>;

/**
 * Where the room's game mode is at, for the HUD. Free-for-all only ever
 * `playing`; a duel or battle royale goes `waiting` → `fighting` → `roundOver` → `fighting`
 * …, back to `waiting` once someone has won the match.
 */
export const Match = schema({
  /** One of `GAME_MODES`. */
  mode: t.string(),
  /** One of `MAPS`: the room's map, chosen by its creator. Never changes. */
  map: t.string(),
  phase: t.string(),
  /** Duel, battle royale: the round being played, from 1; 0 before the first. */
  round: t.uint8(),
  /** Duel, battle royale: from the room's settings. */
  roundsToWin: t.uint8(),
  /** Duel, battle royale: who took the last round; "" before one ends, or for a draw. */
  roundWinnerId: t.string(),
  /** Duel, battle royale: who won the last match; "" until one has been won. */
  matchWinnerId: t.string(),
  /** A Quick Play room: matches start on their own once enough are seated, no Ready. Never changes. */
  autoStart: t.boolean(),
});
export type Match = SchemaType<typeof Match>;

export type MatchPhase = "playing" | "waiting" | "fighting" | "roundOver";

/**
 * A wall raised in the arena (an `Obstacle`, see `shared/obstacles.ts`):
 * synced, so every client draws it and the client's prediction collides with
 * it exactly as the server does. Server-owned.
 */
export const Wall = schema({
  /** Whose skill raised it. */
  ownerId: t.string(),
  /** What it is, for drawing: an earth wall ("wall", also when unset) or a boulder ("boulder"). */
  kind: t.string(),
  x: t.number(),
  y: t.number(),
  /** Radians on the floor; 0 runs along +x. */
  angle: t.number(),
  halfLength: t.number(),
  halfThickness: t.number(),
  height: t.number(),
});
export type Wall = SchemaType<typeof Wall>;

export const MyRoomState = schema({

  players: t.map(Player),

  /** Obstacles standing right now, by id. */
  walls: t.map(Wall),

  match: Match,

});
export type MyRoomState = SchemaType<typeof MyRoomState>;
