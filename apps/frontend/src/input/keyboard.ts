/**
 * Held keys by physical position (`KeyboardEvent.code`, e.g. "KeyW"), not by
 * the character typed — so WASD works on any layout (Ukrainian ЦФІВ, AZERTY…).
 */
const held = new Set<string>();

addEventListener("keydown", (e) => held.add(e.code));
addEventListener("keyup", (e) => held.delete(e.code));
// Keys released while the tab is unfocused never fire keyup.
addEventListener("blur", () => held.clear());

export function isHeld(code: string): boolean {
  return held.has(code);
}

/** Opposite keys cancel out, so the axis is always exactly -1, 0 or 1. */
export function axis(negative: string[], positive: string[]): -1 | 0 | 1 {
  const back = negative.some((code) => held.has(code));
  const forward = positive.some((code) => held.has(code));
  if (back === forward) { return 0; }
  return back ? -1 : 1;
}
