import { SKILL_SLOTS, type SkillSlot } from "@ligma/backend/shared/skills";

/**
 * Which key selects each skill slot — whatever skill the element puts there.
 * Keys are physical positions (`KeyboardEvent.code`), like movement, so a
 * binding stays put on any layout.
 */
export type KeyBindings = Record<SkillSlot, string>;

export const DEFAULT_KEYS: Readonly<KeyBindings> = {
  main: "KeyZ",
  second: "KeyX",
  third: "KeyC",
  ultimate: "KeyR",
};

/** Bindings were once saved per fire skill: each one's slot, to keep them. */
const LEGACY_NAMES: Readonly<Record<SkillSlot, string>> = {
  main: "fireball",
  second: "sunStrike",
  third: "flameBreath",
  ultimate: "twinDragons",
};

/** Keys a skill can't take, and what already uses them. */
const RESERVED_KEYS: Readonly<Record<string, string>> = {
  KeyW: "movement", KeyA: "movement", KeyS: "movement", KeyD: "movement",
  ArrowUp: "movement", ArrowDown: "movement", ArrowLeft: "movement", ArrowRight: "movement",
  Space: "jump",
  Escape: "releasing the mouse",
  Tab: "the browser",
  MetaLeft: "the system", MetaRight: "the system",
  ...(import.meta.env.DEV ? { KeyK: "dev self-damage" } : {}),
};

/** What a key is already used for, if a skill can't take it. */
export function reservedFor(code: string): string | undefined {
  return Object.hasOwn(RESERVED_KEYS, code) ? RESERVED_KEYS[code] : undefined;
}

/** Whether `code` looks like a real `KeyboardEvent.code` a skill may take. */
export function isBindable(code: unknown): code is string {
  return typeof code === "string" && /^[A-Za-z0-9]{1,24}$/.test(code) && reservedFor(code) === undefined;
}

const LABELS: Readonly<Record<string, string>> = {
  ShiftLeft: "Shift", ShiftRight: "R Shift", ControlLeft: "Ctrl", ControlRight: "R Ctrl",
  AltLeft: "Alt", AltRight: "R Alt", CapsLock: "Caps", Backquote: "`", Minus: "-", Equal: "=",
  BracketLeft: "[", BracketRight: "]", Backslash: "\\", Semicolon: ";", Quote: "'",
  Comma: ",", Period: ".", Slash: "/", Enter: "Enter", Backspace: "Bksp",
};

/** Short, readable name for a key: "KeyZ" → "Z", "Digit1" → "1", "Numpad4" → "Num 4". */
export function keyLabel(code: string): string {
  if (Object.hasOwn(LABELS, code)) { return LABELS[code]; }
  const match = /^(Key|Digit|Numpad)(.+)$/.exec(code);
  if (!match) { return code; }
  return match[1] === "Numpad" ? `Num ${match[2]}` : match[2];
}

/**
 * Binds `slot` to `code`. A slot that had `code` gets the old key of `slot`
 * instead, so no key ever selects two skills.
 */
export function rebind(keys: KeyBindings, slot: SkillSlot, code: string): KeyBindings {
  const next = { ...keys };
  const holder = SKILL_SLOTS.find((other) => other !== slot && keys[other] === code);
  if (holder) { next[holder] = keys[slot]; }
  next[slot] = code;
  return next;
}

/** The slot `code` selects, if any. */
export function slotFor(keys: KeyBindings, code: string): SkillSlot | undefined {
  return SKILL_SLOTS.find((slot) => keys[slot] === code);
}

/**
 * Saved bindings are untrusted (old versions, hand edits): any problem falls
 * back to the defaults. Bindings saved per fire skill carry over to its slot.
 */
export function parseKeyBindings(saved: unknown): KeyBindings {
  if (typeof saved !== "object" || saved === null) { return { ...DEFAULT_KEYS }; }
  const record = saved as Record<string, unknown>;
  const keys = { ...DEFAULT_KEYS };
  for (const slot of SKILL_SLOTS) {
    const code = Object.hasOwn(record, slot) ? record[slot] : record[LEGACY_NAMES[slot]];
    if (isBindable(code)) { keys[slot] = code; }
  }
  const unique = new Set(SKILL_SLOTS.map((slot) => keys[slot])).size === SKILL_SLOTS.length;
  return unique ? keys : { ...DEFAULT_KEYS };
}
