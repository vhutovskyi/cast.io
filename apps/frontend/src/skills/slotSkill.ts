/**
 * What the arena's input routing needs from the skill in one of our slots,
 * whatever element put it there. Its key toggles it, a left click (down, up)
 * uses it while selected, and anything else — another skill's key, a right
 * click, death — cancels it. The main skill is never "selected": a click
 * uses it whenever nothing else is.
 */
export interface SlotSkill {
  /** Whether clicks use this skill rather than the main one. */
  readonly selected: boolean;
  /** Its key: select it, or go back to the main skill if already selected. */
  toggle(): void;
  /** Back to the main skill, stopping anything held. */
  cancel(): void;
  /** Left button down. */
  press(): void;
  /** Left button up, wherever it comes up. */
  release(): void;
}
