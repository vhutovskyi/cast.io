import { GAME_MODES, type GameModeConfig, type GameModeId } from "@ligma/backend/shared/gameModes";
import { GAME_MODE_STYLES, createGameModeIcon } from "../ui/gameModes";

/** The mode the menu puts first: the big button in the middle. */
const PRIMARY_MODE: GameModeId = "duel";

/** "1 v 1 · first to 3": what a room started from this button will run. */
function summary(config: GameModeConfig): string {
  switch (config.mode) {
    case "ffa": return `Respawn · ${config.settings.maxPlayers} players`;
    case "duel": return `1 v 1 · first to ${config.settings.roundsToWin}`;
    case "battleRoyale": return `${config.settings.maxPlayers} players · first to ${config.settings.roundsToWin}`;
  }
}

/**
 * One button per game mode; clicking one starts a new room of that mode.
 * Under each, Quick Play: into an open Quick Play room of that mode, or a new
 * one — and under the duel, Ranked: search for a rated match. Returns a
 * function that refreshes each button's summary line from the settings the
 * rooms would get.
 */
export function renderModeButtons(container: HTMLElement, onPlay: (mode: GameModeId) => void, onQuickPlay: (mode: GameModeId) => void, onRanked: () => void) {
  const summaries = new Map<GameModeId, HTMLElement>();

  container.replaceChildren(...GAME_MODES.map((mode) => {
    const card = document.createElement("div");
    card.className = "mode-card";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "mode-button";
    button.classList.toggle("primary", mode === PRIMARY_MODE);

    const icon = document.createElement("span");
    icon.className = "mode-icon";
    icon.append(createGameModeIcon(mode, mode === PRIMARY_MODE ? 28 : 24));

    const text = document.createElement("span");
    const label = document.createElement("strong");
    label.textContent = GAME_MODE_STYLES[mode].label;
    const detail = document.createElement("small");
    summaries.set(mode, detail);
    text.append(label, detail);

    button.append(icon, text);
    button.addEventListener("click", () => onPlay(mode));

    const quick = document.createElement("button");
    quick.type = "button";
    quick.className = "quick-play-button";
    quick.textContent = "Quick Play";
    quick.setAttribute("aria-label", `Quick Play: ${GAME_MODE_STYLES[mode].label}`);
    quick.addEventListener("click", () => onQuickPlay(mode));

    card.append(button, quick);
    if (mode === "duel") {
      const ranked = document.createElement("button");
      ranked.type = "button";
      ranked.className = "quick-play-button ranked-button";
      ranked.textContent = "Ranked";
      ranked.setAttribute("aria-label", "Ranked duel: search for a rated match");
      ranked.addEventListener("click", onRanked);
      card.append(ranked);
    }
    return card;
  }));

  return (configFor: (mode: GameModeId) => GameModeConfig) => {
    for (const [mode, detail] of summaries) { detail.textContent = summary(configFor(mode)); }
  };
}
