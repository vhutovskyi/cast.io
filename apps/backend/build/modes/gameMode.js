import { ARENA_WIDTH, ARENA_HEIGHT } from "../shared/constants.js";
import { clearForcedMotion } from "../shared/movement.js";
import { groundHeight } from "../shared/terrain.js";
/** Puts a player at rest on the ground at (x, y), facing the arena centre. */
export function placeFacingCentre(player, x, y, terrain) {
    player.x = x;
    player.y = y;
    player.z = groundHeight(terrain, x, y);
    player.vx = 0;
    player.vy = 0;
    player.vz = 0;
    clearForcedMotion(player);
    // Same convention as `stepEntity`: at yaw 0 forward is -y.
    player.yaw = Math.atan2(x - ARENA_WIDTH / 2, y - ARENA_HEIGHT / 2);
}
