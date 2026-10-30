import type { ArenaOptions } from "@ligma/backend/rooms/MyRoom";
import { NICKNAME_MAX } from "@ligma/backend/shared/constants";
import type { MagicElement } from "@ligma/backend/shared/elements";
import { BATTLE_ROYALE, DUEL, FFA, parseGameMode, type GameModeConfig, type GameModeId } from "@ligma/backend/shared/gameModes";
import { SKILL_SLOTS, kitOf } from "@ligma/backend/shared/skills";
import { keyLabel, type KeyBindings } from "../input/keyBindings";
import { $ } from "../ui/dom";
import { renderElementPicker } from "./elementPicker";
import { renderModeButtons } from "./modeButtons";
import { renderSkillKit } from "./skillKit";
import { KeySettings } from "./keySettings";
import {
  loadNickname, saveNickname, loadElement, saveElement, loadKeyBindings, saveKeyBindings,
  loadRoomSettings, saveRoomSettings,
} from "./prefs";

/** The player's current lobby choices, read when a room is created or joined. */
export interface LobbyChoices {
  /** What the server needs to seat this player, whether creating or joining. */
  joinOptions(): ArenaOptions & { element: MagicElement };
  /** `mode` with the settings rooms started from here get, validated. */
  gameMode(mode: GameModeId): GameModeConfig;
  keys(): KeyBindings;
}

export interface LobbyHandlers {
  /** Another element was picked: the backdrop shows its mage. */
  onElementChange(element: MagicElement): void;
  /** A mode button was clicked: start a room of it. */
  onPlay(mode: GameModeId): void;
  /** A mode's Quick Play was clicked: find (or start) a Quick Play room of it. */
  onQuickPlay(mode: GameModeId): void;
  /** The duel's Ranked was clicked: search for a rated match. */
  onRanked(): void;
}

/**
 * Wires up the menu: nickname, element, its skills, the settings dialog (skill
 * keys, room settings) and a button per mode. Choices are remembered in this
 * browser.
 */
export function setupLobbyForm({ onElementChange, onPlay, onQuickPlay, onRanked }: LobbyHandlers): LobbyChoices {
  const nicknameInput = $("nickname") as HTMLInputElement;
  nicknameInput.maxLength = NICKNAME_MAX;
  nicknameInput.value = loadNickname();
  nicknameInput.addEventListener("change", () => saveNickname(nicknameInput.value));

  const settingsDialog = $("settings") as HTMLDialogElement;
  const openSettings = () => settingsDialog.showModal();
  $("open-settings").addEventListener("click", openSettings);
  $("close-settings").addEventListener("click", () => settingsDialog.close());
  // The dialog's content fills it edge to edge, so a click on the dialog itself is on the backdrop.
  settingsDialog.addEventListener("click", (e) => { if (e.target === settingsDialog) { settingsDialog.close(); } });

  let keys = loadKeyBindings();
  // Only playable elements are offered or loaded, and those all have a kit.
  let element = loadElement();

  const showKit = () => renderSkillKit($("skill-kit"), kitOf(element)!, keys, openSettings);

  /** Every key hint on the page (ability slots, the help line, the menu's kit) shows the current binding. */
  function showKeys() {
    for (const slot of SKILL_SLOTS) {
      document.querySelectorAll(`[data-key="${slot}"]`).forEach((kbd) => kbd.textContent = keyLabel(keys[slot]));
    }
  }

  const keySettings = new KeySettings($("key-settings"), keys, kitOf(element)!, (chosen: KeyBindings) => {
    keys = chosen;
    saveKeyBindings(chosen);
    showKit();
    showKeys();
  });

  renderElementPicker($("element-picker"), element, (chosen) => {
    element = chosen;
    saveElement(chosen);
    keySettings.setKit(kitOf(chosen)!);
    showKit();
    onElementChange(chosen);
  });
  showKit();
  showKeys();

  // Room settings: each mode reads the ones it has, clamped to its own limits.
  const ffaPlayers = $("ffa-players") as HTMLInputElement;
  const brPlayers = $("br-players") as HTMLInputElement;
  const rounds = $("rounds-to-win") as HTMLInputElement;
  const saved = loadRoomSettings();
  const inputs = [
    [ffaPlayers, FFA.maxPlayers, saved.ffaPlayers],
    [brPlayers, BATTLE_ROYALE.maxPlayers, saved.brPlayers],
    [rounds, DUEL.roundsToWin, saved.roundsToWin],
  ] as const;
  for (const [input, limits, value] of inputs) {
    input.min = String(limits.min);
    input.max = String(limits.max);
    input.value = String(value ?? limits.default);
  }

  /** What the server will make of the settings: the same validation it runs. */
  const gameMode = (mode: GameModeId) => parseGameMode(mode, {
    maxPlayers: (mode === "battleRoyale" ? brPlayers : ffaPlayers).valueAsNumber,
    roundsToWin: rounds.valueAsNumber,
  }) as GameModeConfig;

  const showModes = renderModeButtons($("mode-buttons"), onPlay, onQuickPlay, onRanked);
  function settingsChanged() {
    const ffa = gameMode("ffa");
    const br = gameMode("battleRoyale");
    const duel = gameMode("duel");
    // Typed past a limit: show the value the room will really get.
    if (ffa.mode === "ffa") { ffaPlayers.value = String(ffa.settings.maxPlayers); }
    if (br.mode === "battleRoyale") { brPlayers.value = String(br.settings.maxPlayers); }
    if (duel.mode === "duel") { rounds.value = String(duel.settings.roundsToWin); }
    saveRoomSettings({ ffaPlayers: ffaPlayers.valueAsNumber, brPlayers: brPlayers.valueAsNumber, roundsToWin: rounds.valueAsNumber });
    showModes(gameMode);
  }
  for (const [input] of inputs) { input.addEventListener("change", settingsChanged); }
  settingsChanged();

  return {
    joinOptions: () => ({ nickname: nicknameInput.value.trim(), element }),
    gameMode,
    keys: () => keys,
  };
}
