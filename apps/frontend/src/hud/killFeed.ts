import type { KillEvent } from "@ligma/backend/shared/combat";
import { SKILLS } from "../skills/catalog";

/** How long each line stays before fading out. */
const LINE_MS = 6000;
/** Oldest lines drop off beyond this. */
const MAX_LINES = 5;

/**
 * Top-right "Blaze ☀ Torrent" lines. Names are player-typed, so they only ever
 * go through `textContent`. Lines involving you are highlighted.
 */
export class KillFeed {
  constructor(private readonly container: HTMLElement, private readonly selfId: string) {}

  add(kill: KillEvent) {
    const line = document.createElement("li");
    line.classList.toggle("mine", kill.victimId === this.selfId || kill.killer?.id === this.selfId);

    const victim = name(kill.victimName, "victim");
    if (kill.killer) {
      line.append(name(kill.killer.name, "killer"), SKILLS[kill.killer.ability].icon(16), victim);
    } else {
      line.append(victim, document.createTextNode(" died"));
    }

    this.container.append(line);
    while (this.container.children.length > MAX_LINES) {
      this.container.firstElementChild?.remove();
    }

    setTimeout(() => line.classList.add("fading"), LINE_MS);
    line.addEventListener("transitionend", () => line.remove());
  }

  clear() {
    this.container.replaceChildren();
  }
}

function name(text: string, className: string) {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = text;
  return span;
}
