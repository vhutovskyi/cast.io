import assert from "assert";

import { FREE_MOVEMENT, clearForcedMotion, stepEntity, type EntityState } from "../src/shared/movement.js";
import { FLIGHT_RISE_SPEED, PLAYER_SPEED, TICK_RATE } from "../src/shared/constants.js";
import { moveLimits, EFFECTS, SPEED_BOOST } from "../src/effects/effectConfig.js";

const DT = 1 / TICK_RATE;
const still = { moveX: 0, moveY: 0, yaw: 0, jump: false, breath: false } as const;
const entity = (): EntityState => ({ x: 400, y: 300, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, dashVx: 0, dashVy: 0, dashTime: 0, flightZ: 0 });

describe("forced motion", () => {
  it("slides at the dash velocity, whatever is pressed, until the dash runs out", () => {
    const e = Object.assign(entity(), { dashVx: 600, dashVy: 0, dashTime: 2 * DT });
    stepEntity(e, { ...still, moveY: -1 }, DT, FREE_MOVEMENT);
    assert.ok(Math.abs(e.x - (400 + 600 * DT)) < 1e-9, "dashed along +x");
    assert.strictEqual(e.y, 300, "the forward walk was ignored");
    stepEntity(e, still, DT, FREE_MOVEMENT);
    assert.strictEqual(e.dashTime, 0);
    const x = e.x;
    stepEntity(e, still, DT, FREE_MOVEMENT);
    assert.strictEqual(e.x, x, "stopped once it ran out");
  });

  it("isn't slowed by status effects", () => {
    const e = Object.assign(entity(), { dashVx: 600, dashTime: 1 });
    stepEntity(e, still, DT, moveLimits(["frozen"]));
    assert.ok(e.x > 400);
  });

  it("rises to the flight height without gravity, hovers there, and falls once it's cleared", () => {
    const e = Object.assign(entity(), { flightZ: 300 });
    stepEntity(e, still, DT, FREE_MOVEMENT);
    assert.ok(Math.abs(e.z - FLIGHT_RISE_SPEED * DT) < 1e-9);
    for (let i = 0; i < TICK_RATE; i++) { stepEntity(e, still, DT, FREE_MOVEMENT); }
    assert.strictEqual(e.z, 300, "hovering");
    assert.strictEqual(e.vz, 0);
    stepEntity(e, { ...still, moveY: -1 }, DT, FREE_MOVEMENT);
    assert.ok(e.y < 300, "can walk up there");
    clearForcedMotion(e);
    stepEntity(e, still, DT, FREE_MOVEMENT);
    assert.ok(e.z < 300, "falling");
  });
});

describe("speed boost", () => {
  it("makes walking faster, and combines with the strongest slow", () => {
    const boost = 1 + SPEED_BOOST.percent / 100;
    assert.strictEqual(moveLimits(["speed_boost"]).speedScale, boost);
    assert.ok(Math.abs(moveLimits(["speed_boost", "slow"]).speedScale - boost * 0.7) < 1e-9);
    assert.strictEqual(moveLimits(["speed_boost", "frozen"]).speedScale, 0);
    assert.strictEqual(moveLimits(["slow", "stone_skin"]).speedScale, EFFECTS.slow.moveSpeedScale, "slows still don't stack");

    const e = entity();
    stepEntity(e, { ...still, moveY: -1 }, DT, moveLimits(["speed_boost"]));
    assert.ok(Math.abs((300 - e.y) - PLAYER_SPEED * boost * DT) < 1e-9);
  });
});
