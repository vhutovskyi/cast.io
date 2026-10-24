/** Every skill in the game, by its server id (also its kill-feed credit). */
export const SKILL_IDS = [
    "fireball", "sun_strike", "flame_breath", "twin_dragons", "water_whip", "torrent", "water_clone", "freezing_stream",
    "stones", "stone_skin", "boulders", "earth_wall", "burrow", "rupture",
    "wind_pole", "leap", "puff", "skyfall",
];
/**
 * The four places a skill sits on the ability bar, in order. Keys are bound
 * to slots, not skills, so every element plays with the same keys. The main
 * skill is what clicks cast when nothing else is selected.
 */
export const SKILL_SLOTS = ["main", "second", "third", "ultimate"];
/** Each element's kit. An element without one can't be played yet; an empty one can, without skills. */
export const ELEMENT_KITS = {
    fire: { main: "fireball", second: "sun_strike", third: "flame_breath", ultimate: "twin_dragons" },
    water: { main: "water_whip", second: "torrent", third: "water_clone", ultimate: "freezing_stream" },
    wind: { main: "wind_pole", second: "leap", third: "puff", ultimate: "skyfall" },
    // Stone Skin (`stone_skin`) and Earth Wall (`earth_wall`) are kept, out of the kit, should they come back.
    earth: { main: "stones", second: "boulders", third: "burrow", ultimate: "rupture" },
};
/** The kit of `element`, if it has one. */
export function kitOf(element) {
    return Object.hasOwn(ELEMENT_KITS, element) ? ELEMENT_KITS[element] : undefined;
}
/** Whether a mage of `element` may use `skill`: the servers' check on every cast. */
export function hasSkill(element, skill) {
    const kit = kitOf(element);
    return kit !== undefined && Object.values(kit).includes(skill);
}
/** Which slot `skill` sits in for `element`, if it is in its kit at all. */
export function slotOf(element, skill) {
    const kit = kitOf(element);
    return SKILL_SLOTS.find((slot) => kit?.[slot] === skill);
}
