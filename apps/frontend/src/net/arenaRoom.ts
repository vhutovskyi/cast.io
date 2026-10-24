import type { Room } from "@colyseus/sdk";
import type { MyRoom } from "@ligma/backend/rooms/MyRoom";
import type { MyRoomState } from "@ligma/backend/rooms/schema/MyRoomState";

export type ArenaRoom = Room<MyRoom, MyRoomState>;
