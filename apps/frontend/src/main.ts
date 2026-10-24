import { CloseCode } from "@colyseus/sdk";
import type { MyRoom } from "@ligma/backend/rooms/MyRoom";
import { DEFAULT_MAP } from "@ligma/backend/shared/maps";
import { client } from "./net/client";
import type { ArenaRoom } from "./net/arenaRoom";
import { ArenaScene } from "./render/scene";
import { LobbyShowcase } from "./render/showcase";
import { MouseLook } from "./input/mouseLook";
import { createHud } from "./hud/hud";
import { playArena } from "./arena/playArena";
import { setupLobbyForm } from "./lobby/lobbyForm";
import { watchRooms, renderRooms } from "./lobby/roomList";
import { $ } from "./ui/dom";

const lobbyEl = $("lobby");
const gameUiEl = $("game-ui");
const overlayEl = $("overlay");
const roomListEl = $("room-list");
const lobbyErrorEl = $("lobby-error");
const roomCountEl = $("room-count");

const hud = createHud();
const scene = new ArenaScene($("game"));
// Every room is on the night sky for now; the lobby shows the chosen mage there.
scene.setMap(DEFAULT_MAP);
const showcase = new LobbyShowcase(scene, $("stage"));
const choices = setupLobbyForm({
  onElementChange: (element) => showcase.setElement(element),
  onPlay: (mode) => enterArena(() => client.create<MyRoom>("my_room", { map: DEFAULT_MAP, ...choices.joinOptions(), ...choices.gameMode(mode) })),
  // The server picks the room (and, for a new one, its default settings): see `filterBy` in app.config.ts.
  onQuickPlay: (mode) => enterArena(() => client.joinOrCreate<MyRoom>("my_room", { map: DEFAULT_MAP, ...choices.joinOptions(), mode, quickPlay: true })),
});
showcase.setElement(choices.joinOptions().element);

const look = new MouseLook($("game"), (locked) => overlayEl.hidden = locked);

let currentRoom: ArenaRoom | undefined;

function showLobby() {
  lobbyEl.hidden = false;
  gameUiEl.hidden = true;
  showcase.start();
}

/** Joins an arena, plays until it is left, then returns to the room list. */
async function enterArena(join: () => Promise<ArenaRoom>) {
  if (currentRoom) { return; }
  lobbyErrorEl.textContent = "";
  lobbyEl.classList.add("busy");
  lobbyEl.setAttribute("aria-busy", "true");

  try {
    currentRoom = await join();
    showcase.stop();
    lobbyEl.hidden = true;
    gameUiEl.hidden = false;
    overlayEl.hidden = false;
    const left = await playArena(currentRoom, scene, look, hud, choices.keys());
    // Anything but our own Leave button: say why, instead of silently landing here.
    if (left.code !== CloseCode.CONSENTED) {
      lobbyErrorEl.textContent = `Disconnected from the room (${left.code}${left.reason ? `: ${left.reason}` : ""}).`;
    }
  } catch (e) {
    console.error(e);
    lobbyErrorEl.textContent = `Couldn't join the room: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    currentRoom = undefined;
    lobbyEl.classList.remove("busy");
    lobbyEl.removeAttribute("aria-busy");
    showLobby();
  }
}

$("leave").addEventListener("click", () => currentRoom?.leave());

async function main() {
  showLobby();
  renderRooms(roomListEl, [], () => {});
  const lobby = await client.joinOrCreate("lobby");
  watchRooms(lobby, (rooms) => {
    roomCountEl.textContent = rooms.length ? `${rooms.length} open` : "";
    renderRooms(roomListEl, rooms, (roomId) => {
      enterArena(() => client.joinById<MyRoom>(roomId, choices.joinOptions()));
    });
  });
}

main().catch((e) => {
  console.error(e);
  lobbyErrorEl.textContent = "Can't reach the game server. Is the backend running?";
});
