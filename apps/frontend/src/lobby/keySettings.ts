import { SKILL_SLOTS, type ElementKit, type SkillSlot } from "@ligma/backend/shared/skills";
import { DEFAULT_KEYS, keyLabel, rebind, reservedFor, type KeyBindings } from "../input/keyBindings";
import { SKILLS } from "../skills/catalog";

/**
 * The lobby's "Skill keys" list: one row per slot with its key, named after
 * the chosen element's skill there. Click a key, then press the new one (Esc
 * or a click elsewhere cancels). Taking a key another slot has swaps the two.
 */
export class KeySettings {
  /** The slot waiting for its new key, if any. */
  private listening: SkillSlot | null = null;
  private message = "";

  constructor(
    private readonly container: HTMLElement,
    private keys: KeyBindings,
    private kit: ElementKit,
    private readonly onChange: (keys: KeyBindings) => void,
  ) {
    // Capture phase, so the key never reaches the inputs or the game.
    addEventListener("keydown", (e) => this.onKey(e), true);
    addEventListener("pointerdown", (e) => {
      if (this.listening && !(e.target instanceof Node && this.container.contains(e.target))) { this.stop(""); }
    });
    this.render();
  }

  private onKey(e: KeyboardEvent) {
    if (!this.listening) { return; }
    e.preventDefault();
    e.stopPropagation();
    if (e.code === "Escape") { return this.stop(""); }

    const usedBy = reservedFor(e.code);
    if (usedBy) { return this.stop(`${keyLabel(e.code)} is used for ${usedBy}.`, this.listening); }

    this.set(rebind(this.keys, this.listening, e.code));
    this.stop("");
  }

  private set(keys: KeyBindings) {
    this.keys = keys;
    this.onChange(keys);
  }

  /** Another element was picked: same keys, its skills' names. */
  setKit(kit: ElementKit) {
    this.kit = kit;
    this.render();
  }

  private stop(message: string, keepListening: SkillSlot | null = null) {
    this.listening = keepListening;
    this.message = message;
    this.render();
  }

  private render() {
    const rows = SKILL_SLOTS.map((slot) => {
      const id = this.kit[slot];
      const skill = id && SKILLS[id];
      const skillName = skill ? skill.name : "Not available yet";
      const label = slot === "ultimate" ? `${skillName} (ultimate)` : skillName;
      const row = document.createElement("div");
      row.className = "key-row";

      const name = document.createElement("span");
      name.className = "key-name";
      if (skill) { name.append(skill.icon(18)); }
      name.append(document.createTextNode(label));

      const key = document.createElement("button");
      key.type = "button";
      key.className = "key-button";
      const waiting = this.listening === slot;
      key.classList.toggle("listening", waiting);
      key.textContent = waiting ? "Press a key…" : keyLabel(this.keys[slot]);
      key.setAttribute("aria-label", `${label} key: ${keyLabel(this.keys[slot])}. Click to change.`);
      key.addEventListener("click", () => this.stop("", waiting ? null : slot));

      row.append(name, key);
      return row;
    });

    const footer = document.createElement("div");
    footer.className = "key-footer";
    const message = document.createElement("span");
    message.className = "key-message";
    message.setAttribute("role", "status");
    message.textContent = this.message;
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "key-reset";
    reset.textContent = "Reset";
    reset.disabled = SKILL_SLOTS.every((slot) => this.keys[slot] === DEFAULT_KEYS[slot]);
    reset.addEventListener("click", () => {
      this.set({ ...DEFAULT_KEYS });
      this.stop("");
    });
    footer.append(message, reset);

    this.container.replaceChildren(...rows, footer);
    // Keep keyboard focus on the row being edited after re-rendering.
    if (this.listening) { this.container.querySelectorAll<HTMLButtonElement>(".key-button")[SKILL_SLOTS.indexOf(this.listening)].focus(); }
  }
}
