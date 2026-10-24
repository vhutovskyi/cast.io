import assert from "assert";

import { lineBlocked, obstacleAt, pushOutOfObstacles, type Obstacle } from "../src/shared/obstacles.js";
import { FREE_MOVEMENT, stepEntity } from "../src/shared/movement.js";
import { PLAYER_HALF } from "../src/shared/constants.js";
import { whipStrike } from "../src/skills/waterWhip/waterWhipConfig.js";
import { freezingStreamReach, launchFreezingStream } from "../src/skills/freezingStream/freezingStreamConfig.js";
import { EARTH_WALL, distanceToWall, placeEarthWall } from "../src/skills/earthWall/earthWallConfig.js";

/** A wall across the line x = 400, from y = 250 to 350, 10 thick, 100 tall. */
const ACROSS: Obstacle = { x: 400, y: 300, angle: Math.PI / 2, halfLength: 50, halfThickness: 5, height: 100 };

describe("obstacles", () => {
  it("are touched by a ball overlapping their box, unless it passes over", () => {
    assert.ok(obstacleAt({ x: 400, y: 300, z: 50 }, 1, [ACROSS]));
    assert.ok(obstacleAt({ x: 410, y: 300, z: 50 }, 6, [ACROSS]), "the ball's radius counts");
    assert.ok(!obstacleAt({ x: 410, y: 300, z: 50 }, 4, [ACROSS]));
    assert.ok(!obstacleAt({ x: 400, y: 360, z: 50 }, 4, [ACROSS]), "past its end");
    assert.ok(!obstacleAt({ x: 400, y: 300, z: 110 }, 4, [ACROSS]), "over the top");
  });

  it("block a line through them, but not one around or over them", () => {
    const at = lineBlocked({ x: 300, y: 300, z: 40 }, { x: 500, y: 300, z: 40 }, [ACROSS]);
    assert.ok(at !== null && Math.abs(at - 95 / 200) < 1e-9, "enters at the near face");
    assert.strictEqual(lineBlocked({ x: 300, y: 400, z: 40 }, { x: 500, y: 400, z: 40 }, [ACROSS]), null, "around it");
    assert.strictEqual(lineBlocked({ x: 300, y: 300, z: 120 }, { x: 500, y: 300, z: 120 }, [ACROSS]), null, "over it");
    assert.strictEqual(lineBlocked({ x: 300, y: 300, z: 40 }, { x: 380, y: 300, z: 40 }, [ACROSS]), null, "stopping short");
  });

  it("push a body out onto the nearest face, keeping only the slide along it", () => {
    const pushed = pushOutOfObstacles({ x: 390, y: 300, z: 0 }, PLAYER_HALF, { vx: 100, vy: 50 }, [ACROSS]);
    assert.ok(Math.abs(pushed.x - (400 - 5 - PLAYER_HALF)) < 1e-9);
    assert.ok(Math.abs(pushed.y - 300) < 1e-9);
    assert.ok(Math.abs(pushed.vx) < 1e-9, "no more walking into it");
    assert.ok(Math.abs(pushed.vy - 50) < 1e-9, "still sliding along it");
    const above = pushOutOfObstacles({ x: 400, y: 300, z: 120 }, PLAYER_HALF, { vx: 0, vy: 0 }, [ACROSS]);
    assert.deepStrictEqual(above, { x: 400, y: 300, vx: 0, vy: 0 }, "over the top: nothing to push against");
  });

  it("stop walking in the shared step, server and client alike", () => {
    // Facing +x (yaw -π/2), walking forward into the wall for a second.
    const entity = { x: 350, y: 300, z: 0, vx: 0, vy: 0, vz: 0, yaw: -Math.PI / 2, dashVx: 0, dashVy: 0, dashTime: 0, flightZ: 0 };
    for (let i = 0; i < 30; i++) {
      stepEntity(entity, { moveX: 0, moveY: -1, yaw: -Math.PI / 2, jump: false, breath: false }, 1 / 30, FREE_MOVEMENT, [ACROSS]);
    }
    assert.ok(entity.x <= 400 - 5 - PLAYER_HALF + 1e-6, "never inside it");
    assert.ok(entity.x > 380, "walked up to it");
  });

  it("shield from a lash and stop a freezing stream", () => {
    const caster = { x: 330, y: 300, z: 0 };
    const victim: [string, { x: number; y: number; z: number; hp: number }] = ["victim", { x: 430, y: 300, z: 0, hp: 100 }];
    const aim = { yaw: -Math.PI / 2, pitch: 0 };
    assert.strictEqual(whipStrike("me", caster, aim, [victim]).hitId, "victim");
    const blocked = whipStrike("me", caster, aim, [victim], [ACROSS]);
    assert.strictEqual(blocked.hitId, undefined);
    assert.ok(blocked.end.x <= 395 + 1e-6, "cracks against the wall");

    const launch = launchFreezingStream(caster, aim);
    assert.ok(freezingStreamReach(launch, [ACROSS]).at.x <= 400, "stops at the wall");
  });
});

describe("Earth Wall placement", () => {
  it("stands across the line from the caster, pulled into range", () => {
    const wall = placeEarthWall({ x: 100, y: 300 }, { x: 700, y: 300 }, 0);
    assert.deepStrictEqual([wall.x, wall.y], [100 + EARTH_WALL.range, 300]);
    assert.ok(Math.abs(Math.cos(wall.angle)) < 1e-9, "runs along y: across a line along x");
    assert.strictEqual(wall.height, EARTH_WALL.height);
  });

  it("measures how far a body is from it, edge to edge", () => {
    assert.strictEqual(distanceToWall(ACROSS, { x: 400, y: 300 }), 0);
    assert.ok(Math.abs(distanceToWall(ACROSS, { x: 430, y: 300 }) - (30 - 5 - PLAYER_HALF)) < 1e-9);
    assert.ok(Math.abs(distanceToWall(ACROSS, { x: 400, y: 380 }) - (30 - PLAYER_HALF)) < 1e-9);
  });
});
