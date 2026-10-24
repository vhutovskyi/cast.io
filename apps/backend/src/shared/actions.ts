/**
 * Skill presses that move the caster, carried in the movement input itself
 * (`MoveInput.act`) rather than as a message of their own. Shared code: the
 * frontend imports this file too, so it must stay pure.
 *
 * Why in the input: the server then starts the leap, the soaring or the dig on
 * exactly the step the caster's client pressed it — the step the client has
 * already predicted it on. A message would be applied whenever it happened to
 * arrive, a few of the caster's steps early or late, and the prediction would
 * have to snap to where the server put them.
 *
 * One press per step: `act` is set on the step it is pressed on and back to
 * `none` on the next.
 */
export const INPUT_ACTION = {
  none: 0,
  /** Leap along the input's `yaw`. */
  leap: 1,
  /** Skyfall: soar up. */
  skyfall: 2,
  /** Skyfall, while up: drop onto (`aimX`, `aimY`). */
  skyfallDrop: 3,
  /** Burrow: dig in. */
  burrow: 4,
  /** Burrow, while under: burst out. */
  burrowErupt: 5,
} as const;

export type InputAction = (typeof INPUT_ACTION)[keyof typeof INPUT_ACTION];

/** The highest `act` the room's input sanitizer lets through. */
export const MAX_INPUT_ACTION = INPUT_ACTION.burrowErupt;

/**
 * How much earlier than its cooldown the room accepts a press carried in the
 * input, in ms. The caster's client counts the cooldown from the press; the
 * room from when it applies it, after the trip and the jitter cushion — which
 * shrinks and grows. Without slack, a press sent right on time could land a
 * hair early, be refused, and the prediction would snap back.
 */
export const INPUT_COOLDOWN_SLACK_MS = 250;
