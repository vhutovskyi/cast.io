import type { RoomAvailable } from "@colyseus/sdk";
import type { ArenaMetadata } from "@ligma/backend/rooms/MyRoom";
import { LOBBY_MESSAGE } from "@ligma/backend/shared/messages";
import type { GameModeConfig } from "@ligma/backend/shared/gameModes";
import { DEFAULT_MAP, parseMap, type MapId } from "@ligma/backend/shared/maps";
import { createGameModeIcon, describeGameMode } from "../ui/gameModes";
import { MAP_STYLES } from "../ui/maps";

export type ArenaListing = RoomAvailable<ArenaMetadata> & { locked?: boolean };

interface LobbyRoomLike {
  onMessage(type: string, callback: (message: any) => void): unknown;
}

/**
 * Keeps a live list of open arenas from the server's LobbyRoom: the full list
 * on join, then `+` (added or updated) and `-` (removed) deltas.
 */
export function watchRooms(lobby: LobbyRoomLike, onChange: (rooms: ArenaListing[]) => void) {
  let rooms: ArenaListing[] = [];

  lobby.onMessage(LOBBY_MESSAGE.rooms, (list: ArenaListing[]) => {
    rooms = list;
    onChange(rooms);
  });

  lobby.onMessage(LOBBY_MESSAGE.upsert, ([roomId, room]: [string, ArenaListing]) => {
    const index = rooms.findIndex((r) => r.roomId === roomId);
    rooms = index === -1 ? [...rooms, room] : rooms.with(index, room);
    onChange(rooms);
  });

  lobby.onMessage(LOBBY_MESSAGE.remove, (roomId: string) => {
    rooms = rooms.filter((r) => r.roomId !== roomId);
    onChange(rooms);
  });
}

/** Rooms listed before game modes existed carry none: they are free-for-alls. */
function modeOf(room: ArenaListing): GameModeConfig {
  return room.metadata?.mode ? room.metadata : { mode: "ffa", settings: { maxPlayers: room.maxClients } };
}

/** Rooms listed before maps existed carry none, and a newer server may list one we don't know: the default. */
function mapOf(room: ArenaListing): MapId {
  return parseMap(room.metadata?.map) ?? DEFAULT_MAP;
}

/**
 * Renders the room list. Room names are player-typed, so they only ever go
 * through `textContent` — never innerHTML.
 */
export function renderRooms(listEl: HTMLElement, rooms: ArenaListing[], onJoin: (roomId: string) => void) {
  listEl.replaceChildren();

  if (rooms.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    const title = document.createElement("strong");
    title.textContent = "No open rooms";
    const hint = document.createElement("span");
    hint.textContent = "Pick a mode below to start one.";
    empty.append(title, hint);
    listEl.append(empty);
    return;
  }

  for (const room of rooms) {
    const full = room.locked || room.clients >= room.maxClients;

    const mode = modeOf(room);
    const item = document.createElement("li");
    const icon = createGameModeIcon(mode.mode, 20);

    const title = document.createElement("span");
    title.className = "title";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = room.metadata?.name ?? room.roomId;
    const kind = document.createElement("span");
    kind.className = "mode";
    kind.textContent = `${room.metadata?.quickPlay ? "Quick Play · " : ""}${describeGameMode(mode)} · ${MAP_STYLES[mapOf(room)].label}`;
    title.append(name, kind);

    const players = document.createElement("span");
    players.className = "players";
    players.textContent = `${room.clients}/${room.maxClients}`;

    const join = document.createElement("button");
    join.type = "button";
    join.className = "join-button";
    join.textContent = full ? "Full" : "Join";
    join.disabled = full;
    join.addEventListener("click", () => onJoin(room.roomId));

    item.append(icon, title, players, join);
    listEl.append(item);
  }
}
