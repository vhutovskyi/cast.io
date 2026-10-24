import type { SkillId } from "./skills.js";

/** Abilities that can land a kill, for the kill feed's icon. */
export type KillAbility = SkillId;

/**
 * Who dealt the damage. The name is captured when the attack starts, so a
 * kill still credits the caster even if they left before it landed.
 */
export interface DamageSource {
  id: string;
  name: string;
  ability: KillAbility;
}

export interface DamageOptions {
  /** Damage dealt by a status effect itself: it never applies more effects. */
  fromEffect?: boolean;
}

/** Server → everyone: a player dropped to 0 HP. No killer = died on their own. */
export interface KillEvent {
  victimId: string;
  victimName: string;
  killer?: DamageSource;
}
