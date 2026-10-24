import { NICKNAME_MAX } from "@ligma/backend/shared/constants";
import { DEFAULT_ELEMENT, isPlayableElement, type MagicElement } from "@ligma/backend/shared/elements";
import { parseKeyBindings, type KeyBindings } from "../input/keyBindings";

const NICKNAME_KEY = "ligma.nickname";
const ELEMENT_KEY = "ligma.element";
const KEYS_KEY = "ligma.keys";
/** Before the menu had a button per mode: the one mode last picked, with its settings. Read only. */
const MODE_KEY = "ligma.mode";
const ROOM_SETTINGS_KEY = "ligma.roomSettings";

/**
 * Lobby choices remembered in this browser only (never stored server-side)
 * and sent with every room joined. Storage can throw in some private-browsing
 * modes, in which case choices just aren't remembered.
 */
function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not remembered; still used for this session.
  }
}

export function loadNickname(): string {
  return read(NICKNAME_KEY) ?? "";
}

export function saveNickname(nickname: string) {
  write(NICKNAME_KEY, nickname.trim().slice(0, NICKNAME_MAX));
}

/** Falls back to the default if the saved element isn't playable (any more). */
export function loadElement(): MagicElement {
  const saved = read(ELEMENT_KEY);
  return isPlayableElement(saved) ? saved : DEFAULT_ELEMENT;
}

export function saveElement(element: MagicElement) {
  write(ELEMENT_KEY, element);
}

export function loadKeyBindings(): KeyBindings {
  try {
    return parseKeyBindings(JSON.parse(read(KEYS_KEY) ?? "null"));
  } catch {
    return parseKeyBindings(null);
  }
}

export function saveKeyBindings(keys: KeyBindings) {
  write(KEYS_KEY, JSON.stringify(keys));
}

/** What rooms started from the menu get, per setting; unvalidated, `parseGameMode` clamps them. */
export interface RoomSettings {
  ffaPlayers?: number;
  brPlayers?: number;
  roundsToWin?: number;
}

export function loadRoomSettings(): RoomSettings {
  try {
    const saved = JSON.parse(read(ROOM_SETTINGS_KEY) ?? "null");
    if (saved && typeof saved === "object") { return saved; }
    const old = JSON.parse(read(MODE_KEY) ?? "null");
    const settings = old?.settings ?? {};
    return {
      roundsToWin: settings.roundsToWin,
      [old?.mode === "battleRoyale" ? "brPlayers" : "ffaPlayers"]: settings.maxPlayers,
    };
  } catch {
    return {};
  }
}

export function saveRoomSettings(settings: RoomSettings) {
  write(ROOM_SETTINGS_KEY, JSON.stringify(settings));
}
