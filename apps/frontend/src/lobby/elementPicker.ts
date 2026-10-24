import { ELEMENTS, isPlayableElement, type MagicElement } from "@ligma/backend/shared/elements";
import { ELEMENT_STYLES } from "../ui/elements";
import { createElementArt } from "../ui/elementArt";

/**
 * One radio tile per element, outlined in its own colour when chosen.
 * Elements that aren't playable yet are shown but disabled, so players can
 * see what's coming.
 */
export function renderElementPicker(container: HTMLElement, selected: MagicElement, onChange: (element: MagicElement) => void) {
  container.replaceChildren();

  for (const element of ELEMENTS) {
    const playable = isPlayableElement(element);

    const option = document.createElement("label");
    option.className = "element-tile";
    option.style.setProperty("--el", `#${ELEMENT_STYLES[element].color.toString(16).padStart(6, "0")}`);

    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "element";
    radio.value = element;
    radio.checked = element === selected;
    radio.disabled = !playable;
    radio.addEventListener("change", () => onChange(element));

    const name = document.createElement("span");
    name.textContent = ELEMENT_STYLES[element].label;

    option.append(radio, createElementArt(element), name);

    if (!playable) {
      const soon = document.createElement("span");
      soon.className = "soon";
      soon.textContent = "Soon";
      option.append(soon);
    }

    container.append(option);
  }
}
