import { ELEMENT_KITS } from "./skills.js";

/** Every element a mage can belong to, in picker order. */
export const ELEMENTS = ["fire", "water", "wind", "earth"] as const;
export type MagicElement = (typeof ELEMENTS)[number];

/** Elements that can be chosen today: those with a kit. The rest show as "coming soon". */
export const PLAYABLE_ELEMENTS: readonly MagicElement[] = ELEMENTS.filter((element) => ELEMENT_KITS[element] !== undefined);

export const DEFAULT_ELEMENT: MagicElement = "fire";

export function isPlayableElement(value: unknown): value is MagicElement {
  return PLAYABLE_ELEMENTS.includes(value as MagicElement);
}
