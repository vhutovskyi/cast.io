import type { MapSchema } from "@colyseus/schema";
import type { Player } from "@ligma/backend/rooms/schema/MyRoomState";
import type { Avatar } from "../render/scene";

/** What the arena hands a skill's controller once per rendered frame. */
export interface ArenaFrame {
  /** Seconds since the last frame, capped. */
  dt: number;
  /** The mouse is captured: we are playing, not in the menu. */
  locked: boolean;
  /** We are alive. */
  alive: boolean;
  /** Clicks use the main skill: nothing else is selected. */
  mainSelected: boolean;
  /** Our live view direction (radians), as the mouse has it. */
  yaw: number;
  pitch: number;
  /** Where we see ourselves: our predicted position (simulation units). */
  self: { x: number; y: number; z: number };
  /** Everyone in the room, by session id (synced state). */
  players: MapSchema<Player>;
  /** Remote players' bodies, by session id; we have none (first person). */
  avatars: ReadonlyMap<string, Avatar>;
}

/** What the arena does with a skill's controller besides routing input to it (`SlotSkill`). */
export interface ArenaSkillController {
  /** Once per rendered frame. */
  update(frame: ArenaFrame): void;
  /** A fresh round: drop cooldowns and whatever is being drawn. */
  reset(): void;
  /** The arena is torn down. */
  dispose(): void;
  /** A remote player joined: their body, to hang things on. */
  addPlayer?(sessionId: string, avatar: Avatar, player: Player): void;
  removePlayer?(sessionId: string): void;
}
