import { ELEMENT_KITS } from "./skills.js";
/** Every element a mage can belong to, in picker order. */
export const ELEMENTS = ["fire", "water", "wind", "earth"];
/** Elements that can be chosen today: those with a kit. The rest show as "coming soon". */
export const PLAYABLE_ELEMENTS = ELEMENTS.filter((element) => ELEMENT_KITS[element] !== undefined);
export const DEFAULT_ELEMENT = "fire";
export function isPlayableElement(value) {
    return PLAYABLE_ELEMENTS.includes(value);
}
