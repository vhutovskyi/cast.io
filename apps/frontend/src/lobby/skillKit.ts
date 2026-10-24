import { SKILL_SLOTS, type ElementKit } from "@ligma/backend/shared/skills";
import { keyLabel, type KeyBindings } from "../input/keyBindings";
import { SKILLS } from "../skills/catalog";

/**
 * The chosen element's skills under the mage: one square per slot with its
 * key, named in a tooltip on hover or focus. Clicking one opens the key
 * settings (`onPick`).
 */
export function renderSkillKit(container: HTMLElement, kit: ElementKit, keys: KeyBindings, onPick: () => void) {
  container.replaceChildren(...SKILL_SLOTS.map((slot) => {
    const id = kit[slot];
    const skill = id && SKILLS[id];
    const name = skill ? skill.name : "Not available yet";
    const key = keyLabel(keys[slot]);
    const ultimate = slot === "ultimate";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "kit-skill";
    button.classList.toggle("ultimate", ultimate);
    button.classList.toggle("empty", !skill);
    button.setAttribute("aria-label", `${name}${ultimate ? " (ultimate)" : ""}, key ${key}. Change keys.`);
    if (skill) { button.append(skill.icon(30)); }

    // Visual only: the button's label already says all of it.
    const tip = document.createElement("span");
    tip.className = "kit-tip";
    tip.setAttribute("aria-hidden", "true");
    tip.textContent = name;
    const detail = document.createElement("small");
    if (ultimate) {
      const tag = document.createElement("span");
      tag.className = "ult";
      tag.textContent = "Ultimate";
      detail.append(tag, ` · ${key}`);
    } else {
      detail.textContent = `Key ${key}`;
    }
    tip.append(detail);

    const kbd = document.createElement("kbd");
    kbd.dataset.key = slot;
    kbd.textContent = key;

    button.append(tip, kbd);
    button.addEventListener("click", onPick);

    const item = document.createElement("li");
    item.append(button);
    return item;
  }));
}
