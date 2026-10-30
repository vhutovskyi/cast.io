import { CloseCode, type SeatReservation } from "@colyseus/sdk";
import type { MyRoom } from "@ligma/backend/rooms/MyRoom";
import type { MyRoomState } from "@ligma/backend/rooms/schema/MyRoomState";
import type { RankedMatchFound } from "@ligma/backend/shared/ranked";
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
import { RankedSearch } from "./lobby/rankedSearch";
import { AccountPanel } from "./lobby/account";
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
  // Ranked is for signed-in players: their rating and dodge lockouts belong to the account.
  onRanked: () => account.requireSignIn(() => searchRanked()),
});

const account = new AccountPanel(
  {
    line: $("account"), dialog: $("sign-in") as HTMLDialogElement, title: $("sign-in-title"),
    signInStep: $("sign-in-step"), providers: $("sign-in-providers"),
    nameStep: $("name-step") as HTMLFormElement, nameInput: $("ranked-name") as HTMLInputElement,
    nameSave: $("ranked-name-save") as HTMLButtonElement,
    note: $("sign-in-note"), close: $("close-sign-in") as HTMLButtonElement,
  },
  // A first ranked name: whatever nickname they've typed, for them to keep or change.
  () => choices.joinOptions().nickname ?? "",
  () => rankedSearch.stop(),
);

const rankedSearch = new RankedSearch(
  { root: $("ranked-search"), title: $("ranked-title"), detail: $("ranked-detail"), cancel: $("ranked-cancel") as HTMLButtonElement },
  (found) => playRanked(found),
  (message) => lobbyErrorEl.textContent = message,
);

/** Searches for a ranked duel, signed in, with the menu's element. The name shown is the account's, not the nickname. */
function searchRanked(note?: string) {
  lobbyErrorEl.textContent = "";
  rankedSearch.start({ element: choices.joinOptions().element }, note);
}

/**
 * Plays the ranked match the queue found. If it's called off before it
 * starts — the opponent never came, or left first — straight back to
 * searching, where the server keeps our place.
 */
async function playRanked(found: RankedMatchFound) {
  const reservation = found.reservation as SeatReservation;
  const outcome = await enterArena(() => client.consumeSeatReservation<MyRoomState>(reservation) as Promise<ArenaRoom>, true);
  rankedSearch.hide();
  if (outcome === "opponentDodged" || outcome === "failed") {
    searchRanked("Your opponent didn't show up: back in the queue, in the same place.");
    lobbyErrorEl.textContent = "";
  }
}
showcase.setElement(choices.joinOptions().element);

const look = new MouseLook($("game"), (locked) => overlayEl.hidden = locked);

let currentRoom: ArenaRoom | undefined;

function showLobby() {
  lobbyEl.hidden = false;
  gameUiEl.hidden = true;
  showcase.start();
}

/**
 * Joins an arena, plays until it is left, then returns to the room list.
 * Anything but a ranked match the queue found stops a ranked search.
 */
async function enterArena(join: () => Promise<ArenaRoom>, ranked = false): Promise<"left" | "opponentDodged" | "failed" | undefined> {
  if (currentRoom) { return; }
  if (!ranked) { rankedSearch.stop(); }
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
    if (left.rankedCancelled === "opponentDodged") { return "opponentDodged"; }
    // A deploy: casual rooms close at once, a ranked match only if it couldn't wait for it to end.
    if (left.code === CloseCode.SERVER_SHUTDOWN) {
      lobbyErrorEl.textContent = left.rankedCancelled === "serverRestart"
        ? "The server restarted for an update before your ranked match finished: it doesn't count. Try again in a minute."
        : "The server is restarting for an update. Try again in a minute.";
      return "left";
    }
    // Anything but our own Leave button: say why, instead of silently landing here.
    if (left.code !== CloseCode.CONSENTED) {
      lobbyErrorEl.textContent = `Disconnected from the room (${left.code}${left.reason ? `: ${left.reason}` : ""}).`;
    }
    return "left";
  } catch (e) {
    console.error(e);
    lobbyErrorEl.textContent = `Couldn't join the room: ${e instanceof Error ? e.message : String(e)}`;
    return "failed";
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
