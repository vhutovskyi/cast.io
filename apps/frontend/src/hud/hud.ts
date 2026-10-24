import { SKILL_SLOTS, type ElementKit, type SkillSlot } from "@ligma/backend/shared/skills";
import { SKILLS } from "../skills/catalog";
import { $ } from "../ui/dom";
import type { MatchHudUi } from "./matchHud";

/** The ability slot in the HUD: icon, key hint and a cooldown sweep. */
export interface AbilitySlotUi {
  root: HTMLElement;
  cooldownText: HTMLElement;
}

/**
 * Fills the ability bar and the controls help line with `kit`'s skills, slot
 * by slot. A slot the kit leaves empty shows dimmed, and isn't in the help line.
 */
export function showKit(hud: Hud, kit: ElementKit) {
  for (const slot of SKILL_SLOTS) {
    const id = kit[slot];
    const skill = id && SKILLS[id];
    const { root } = hud.abilities[slot];
    root.title = skill ? skill.name : "Not available yet";
    root.classList.toggle("empty", !skill);
    root.querySelector(":scope > svg")?.remove();
    if (skill) { root.prepend(skill.icon(30)); }
    const label = !skill ? "" : skill.hint ? `${skill.name} (${skill.hint})` : skill.name;
    document.querySelectorAll(`[data-skill-name="${slot}"]`).forEach((el) => el.textContent = label);
    document.querySelectorAll<HTMLElement>(`[data-skill-help="${slot}"]`).forEach((el) => el.hidden = !skill);
  }
}

export interface Hud {
  status: HTMLElement;
  healthFill: HTMLElement;
  healthText: HTMLElement;
  elementIcon: HTMLElement;
  /** Squares for the status effects on us, next to the health bar. */
  statusEffects: HTMLElement;
  /** By slot; which skill each shows is set per arena by `showKit`. */
  abilities: Record<SkillSlot, AbilitySlotUi>;
  /** The "You died" panel with its Respawn button — or, in a duel, a note instead. */
  death: HTMLElement;
  deathNote: HTMLElement;
  respawn: HTMLButtonElement;
  killFeed: HTMLElement;
  /** Duel: round, score and what's next. */
  match: MatchHudUi;
  /** Duel: shown with the menu while waiting for a match. */
  ready: HTMLButtonElement;
}

/** Finds the in-game HUD in index.html. The skill icons go in once we know our element (`showKit`). */
export function createHud(): Hud {
  const abilities = {} as Record<SkillSlot, AbilitySlotUi>;
  for (const slot of SKILL_SLOTS) {
    const id = `ability-${slot}`;
    abilities[slot] = { root: $(id), cooldownText: $(`${id}-cd`) };
  }

  return {
    status: $("status"),
    healthFill: $("health-fill"),
    healthText: $("health-text"),
    elementIcon: $("health-element"),
    statusEffects: $("status-effects"),
    abilities,
    death: $("death"),
    deathNote: $("death-note"),
    respawn: $("respawn") as HTMLButtonElement,
    killFeed: $("kill-feed"),
    match: {
      root: $("match-banner"),
      score: $("match-score"),
      headline: $("match-headline"),
      hint: $("match-hint"),
      result: $("match-result"),
      resultTitle: $("match-result-title"),
      overlayTitle: $("overlay-title"),
    },
    ready: $("ready") as HTMLButtonElement,
  };
}
