import assert from "assert";

import { FLAT, groundHeight, raycastTerrain, terrainFromHills, type Terrain } from "../src/shared/terrain.js";
import { FREE_MOVEMENT, stepEntity } from "../src/shared/movement.js";
import { MAP_TERRAIN, PLAYABLE_MAPS } from "../src/shared/maps.js";

/** One gentle mound in the middle of the arena: 40 high, 200 wide. */
const MOUND = terrainFromHills([{ x: 400, y: 300, radius: 100, height: 40 }]);

/** A 60-high step at x = 400: the left half is low, the right half a plateau. */
const CLIFF: Terrain = { cols: 3, rows: 2, heights: [0, 0, 60, 0, 0, 60] };

const DT = 1 / 30;
const at = (x: number, y: number, z = 0) =>
  ({ x, y, z, vx: 0, vy: 0, vz: 0, yaw: 0, dashVx: 0, dashVy: 0, dashTime: 0, flightZ: 0 });
/** Facing +x (yaw -π/2), walking forward. */
const EAST = { moveX: 0, moveY: -1, yaw: -Math.PI / 2, jump: false, breath: false };
const STILL = { moveX: 0, moveY: 0, yaw: 0, jump: false, breath: false };

describe("terrain", () => {
  it("is flat at 0 on the flat map, everywhere and past the edges", () => {
    for (const [x, y] of [[0, 0], [400, 300], [800, 600], [-50, 700]]) {
      assert.strictEqual(groundHeight(FLAT, x, y), 0);
    }
  });

  it("builds hills: highest at the centre, flat beyond their radius", () => {
    assert.ok(Math.abs(groundHeight(MOUND, 400, 300) - 40) < 1e-9);
    assert.ok(Math.abs(groundHeight(MOUND, 450, 300) - 20) < 1e-9, "halfway down at half the radius");
    assert.strictEqual(groundHeight(MOUND, 520, 300), 0);
  });

  it("is bilinear between samples", () => {
    assert.strictEqual(groundHeight(CLIFF, 200, 300), 0);
    assert.strictEqual(groundHeight(CLIFF, 600, 300), 30, "halfway up the ramp to the far column");
    assert.strictEqual(groundHeight(CLIFF, 900, 300), 60, "past the edge reads the edge");
  });

  it("stops a ray where it meets the ground, hills before the floor behind them", () => {
    const down = raycastTerrain(FLAT, { x: 100, y: 300, z: 40 }, { x: 1, y: 0, z: -1 }, 1000);
    assert.ok(down && Math.abs(down.x - 140) < 1e-3 && Math.abs(down.z) < 1e-3);

    const level = raycastTerrain(MOUND, { x: 200, y: 300, z: 20 }, { x: 1, y: 0, z: 0 }, 1000);
    assert.ok(level && Math.abs(level.x - 350) < 0.5, "hits the mound's near side at its own height");
    assert.strictEqual(raycastTerrain(MOUND, { x: 200, y: 300, z: 60 }, { x: 1, y: 0, z: 0 }, 1000), null, "over the top and out");
    assert.strictEqual(raycastTerrain(FLAT, { x: 100, y: 300, z: 40 }, { x: 1, y: 0, z: -1 }, 30), null, "too short to reach");
  });

  it("walks a body up and over a gentle hill, staying on the ground", () => {
    const entity = at(250, 300);
    for (let i = 0; i < 60; i++) {
      stepEntity(entity, EAST, DT, FREE_MOVEMENT, [], MOUND);
      assert.ok(Math.abs(entity.z - groundHeight(MOUND, entity.x, entity.y)) < 1e-9, `on the ground at x=${entity.x}`);
    }
    assert.ok(entity.x > 550, "crossed it");
  });

  it("stops a body at ground too steep to climb, unless it jumps over it", () => {
    const cliff: Terrain = { cols: 41, rows: 2, heights: [...Array(41).keys(), ...Array(41).keys()].map((i) => (i >= 20 ? 60 : 0)) };
    const walker = at(300, 300);
    for (let i = 0; i < 30; i++) { stepEntity(walker, EAST, DT, FREE_MOVEMENT, [], cliff); }
    assert.ok(walker.x < 400 && walker.z === 0, "held at the foot");

    const flyer = at(300, 300, 150);
    for (let i = 0; i < 30; i++) { stepEntity(flyer, EAST, DT, FREE_MOVEMENT, [], cliff); }
    assert.ok(flyer.x > 400 && flyer.z === 60, "dropped onto the plateau from above");
  });

  it("lets a body jump from a hillside and land back on it", () => {
    const entity = at(450, 300, groundHeight(MOUND, 450, 300));
    stepEntity(entity, { ...STILL, jump: true }, DT, FREE_MOVEMENT, [], MOUND);
    assert.ok(entity.z > 20 && entity.vz > 0, "took off");
    for (let i = 0; i < 30; i++) { stepEntity(entity, STILL, DT, FREE_MOVEMENT, [], MOUND); }
    assert.ok(Math.abs(entity.z - 20) < 1e-9 && entity.vz === 0, "landed where it stood");
  });

  it("keeps every playable map flat until the skills read the terrain", () => {
    for (const map of PLAYABLE_MAPS) { assert.strictEqual(MAP_TERRAIN[map], FLAT, map); }
  });
});
