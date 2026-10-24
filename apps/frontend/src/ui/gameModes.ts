import type { GameModeConfig, GameModeId } from "@ligma/backend/shared/gameModes";
import { createSvgIcon, svgShape } from "./dom";

interface GameModeStyle {
  label: string;
  /** One line under the label in the mode picker. */
  blurb: string;
  /** 24×24 icon: filled shapes and stroked lines, static path data only. */
  fills: { d: string; color: string }[];
  strokes: { d: string; color: string }[];
}

export const GAME_MODE_STYLES: Record<GameModeId, GameModeStyle> = {
  ffa: {
    label: "Free-for-all",
    blurb: "Everyone for themselves, respawn",
    // A burst: everyone hitting everyone.
    fills: [
      { d: "M12 1.5l2.3 5.6 5.9-1.6-3.2 5.2 5.5 2.6-6 .9 1.1 6-4.6-4-4.6 4 1.1-6-6-.9 5.5-2.6-3.2-5.2 5.9 1.6z", color: "#ff8c2b" },
      { d: "M12 8.5l1.2 2.4 2.6.4-1.9 1.8.5 2.6-2.4-1.3-2.4 1.3.5-2.6-1.9-1.8 2.6-.4z", color: "#ffd27a" },
    ],
    strokes: [],
  },
  duel: {
    label: "Duel",
    blurb: "One on one, in rounds",
    fills: [],
    // Crossed swords: blades, then guards and grips.
    strokes: [
      { d: "M4 4l11 11M20 4L9 15", color: "#cfd8e6" },
      { d: "M13 17l4-4M7 13l4 4M16.5 16.5l3 3M7.5 16.5l-3 3", color: "#6fb7ff" },
    ],
  },
  battleRoyale: {
    label: "Battle royale",
    blurb: "Last one standing, in rounds",
    // A crown: the last one standing.
    fills: [
      { d: "M3 8l4.5 4L12 4l4.5 8L21 8l-2 10H5z", color: "#ffc93c" },
      { d: "M5 19.5h14V21H5z", color: "#e0a526" },
    ],
    strokes: [],
  },
};

/** Builds a mode's icon with DOM APIs. Used by the mode picker and the room list. */
export function createGameModeIcon(mode: GameModeId, size = 16): SVGSVGElement {
  const style = GAME_MODE_STYLES[mode];
  const svg = createSvgIcon(style.label, size);
  for (const { d, color } of style.fills) {
    svg.append(svgShape("path", { d, fill: color }));
  }
  for (const { d, color } of style.strokes) {
    svg.append(svgShape("path", { d, fill: "none", stroke: color, "stroke-width": 2.2, "stroke-linecap": "round" }));
  }
  return svg;
}

/**
 * "Free-for-all", "Duel · first to 3": the mode and the settings that matter,
 * for the room list. Seats aren't among them: the list shows them as `2/8`.
 */
export function describeGameMode(config: GameModeConfig): string {
  switch (config.mode) {
    case "ffa": return GAME_MODE_STYLES.ffa.label;
    case "duel": return `${GAME_MODE_STYLES.duel.label} · first to ${config.settings.roundsToWin}`;
    case "battleRoyale": return `${GAME_MODE_STYLES.battleRoyale.label} · first to ${config.settings.roundsToWin}`;
  }
}
