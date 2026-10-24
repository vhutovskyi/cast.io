/** Longest room name shown in the room list. */
export const ROOM_NAME_MAX = 32;

/** Longest nickname shown above a character. */
export const NICKNAME_MAX = 16;

/** Health every player spawns with. */
export const MAX_HP = 100;

/** How long a dead player waits before the Respawn button works. */
export const RESPAWN_DELAY_MS = 3000;

/** Simulation rate in Hz. One input advances exactly one step at this rate. */
export const TICK_RATE = 60;

export const ARENA_WIDTH = 800;
export const ARENA_HEIGHT = 600;

/** Half-extent of a player square, used for wall clamping. */
export const PLAYER_HALF = 12;

/** Feet to top of the head — the rendered capsule's height, for hit tests. */
export const PLAYER_HEIGHT = 44;

/** First-person eye height above the feet, just under the top of the head. */
export const EYE_HEIGHT = 38;

/** Just short of straight up/down, so the view never flips over. */
export const PITCH_LIMIT = Math.PI / 2 - 0.05;

/** Units per second at full stick. */
export const PLAYER_SPEED = 260;

/** Downward acceleration in units/s². */
export const GRAVITY = 700;

/** How fast a player climbs to their `flightZ` (Skyfall), in units/s. */
export const FLIGHT_RISE_SPEED = 900;

/** Upward speed at take-off: ~35 units high, ~0.63 s in the air. */
export const JUMP_SPEED = 220;
