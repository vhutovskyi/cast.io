import assert from "assert";
import type { Clock } from "colyseus";

import { MyRoomState, Player } from "../src/rooms/schema/MyRoomState.js";
import { MAX_HP, PLAYER_HALF } from "../src/shared/constants.js";
import type { DamageOptions, DamageSource } from "../src/shared/combat.js";
import { StatusEffects } from "../src/effects/statusEffects.js";
import { GroundZones, GROUND_ZONE_HEIGHT } from "../src/effects/groundZones.js";
import { EFFECTS, ABILITY_EFFECTS, canCast, moveLimits, type EffectDef } from "../src/effects/effectConfig.js";
import { FREE_MOVEMENT, stepEntity } from "../src/shared/movement.js";
import { PLAYER_SPEED } from "../src/shared/constants.js";

/** Test-only effects, so these tests don't change with the real balance. */
const DEFS: Record<string, EffectDef> = {
  dot: { durationMs: 1000, tick: { everyMs: 250, damage: 5 } },
  shield: { durationMs: 500, damageTakenScale: 0.5 },
};

const FIREBALL_SOURCE: DamageSource = { id: "caster", name: "Caster", ability: "fireball" };

/** A room stand-in: real state, a clock the test moves by hand, and `MyRoom.damage`'s rules. */
function fakeRoom(abilityEffects = {}) {
  const state = new MyRoomState();
  const clock = { currentTime: 0 } as Clock;
  const hits: { sessionId: string; amount: number; source?: DamageSource; options?: DamageOptions }[] = [];
  const room = {
    state,
    clock,
    canAct: (sessionId: string) => (state.players.get(sessionId)?.hp ?? 0) > 0,
    damage(sessionId: string, amount: number, source?: DamageSource, options?: DamageOptions) {
      const player = state.players.get(sessionId);
      if (!player || player.hp <= 0) { return; }
      hits.push({ sessionId, amount, source, options });
      player.hp = Math.max(0, player.hp - Math.round(amount * effects.damageTakenScale(sessionId)));
      if (player.hp === 0) { effects.clear(sessionId); }
    },
  };
  const effects = new StatusEffects(room, DEFS, abilityEffects);
  const zones = new GroundZones(room, effects);
  const join = (sessionId: string, x = 100, y = 100) => {
    const player = new Player({ name: sessionId, hp: MAX_HP, element: "fire", x, y, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, dashVx: 0, dashVy: 0, dashTime: 0, flightZ: 0, breathing: false, ready: false, wins: 0, ownerId: "" });
    state.players.set(sessionId, player);
    return player;
  };
  /** Advances the clock one `ms` step at a time, running zones then effects like the room does. */
  const advance = (ms: number, stepMs = 50) => {
    for (let t = 0; t < ms; t += stepMs) {
      clock.currentTime += stepMs;
      zones.step();
      effects.step();
    }
  };
  return { room, effects, zones, join, advance, hits };
}

describe("status effects", () => {
  it("can be applied for another duration, never cutting what's left short", () => {
    const { effects, join, advance } = fakeRoom();
    join("a");
    effects.apply("a", "shield", undefined, 2000);
    advance(1000);
    effects.apply("a", "shield"); // its own 500 ms would end sooner: the 2000 stands
    advance(900);
    assert.ok(effects.has("a", "shield"));
    advance(200);
    assert.ok(!effects.has("a", "shield"));
  });

  describe("movement and casting limits", () => {
    const step = (limits = FREE_MOVEMENT, jump = false) => {
      const entity = { x: 100, y: 100, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, dashVx: 0, dashVy: 0, dashTime: 0, flightZ: 0 };
      stepEntity(entity, { moveX: 0, moveY: -1, yaw: 0, jump, breath: false }, 0.1, limits);
      return entity;
    };

    it("slows walking by the strongest slow, without stacking", () => {
      assert.deepStrictEqual(moveLimits([]), FREE_MOVEMENT);
      assert.strictEqual(moveLimits(["slow"]).speedScale, 0.7);
      assert.strictEqual(moveLimits(["slow", "burn", "unknown"]).speedScale, 0.7, "other and unknown effects change nothing");
      assert.strictEqual(moveLimits(["slow", "frozen"]).speedScale, 0, "the strongest counts");
      assert.ok(Math.abs(step(moveLimits(["slow"])).vy + PLAYER_SPEED * 0.7) < 1e-9);
    });

    it("freezes a player solid: no walking, no jumping, no casting", () => {
      const frozen = moveLimits(["frozen"]);
      assert.deepStrictEqual(frozen, { speedScale: 0, canJump: false });
      const entity = step(frozen, true);
      assert.deepStrictEqual([entity.x, entity.y, entity.z], [100, 100, 0]);
      assert.strictEqual(canCast(["frozen"]), false);
      assert.strictEqual(canCast(["slow", "burn"]), true);
      assert.ok(step(FREE_MOVEMENT, true).z > 0, "free players still jump");
    });
  });

  it("ships a burn of 5 HP a second for 3 s put on by Twin Dragons, and a 30% slow for 2 s put on by Torrent", () => {
    assert.deepStrictEqual(EFFECTS.burn, { durationMs: 3000, tick: { everyMs: 1000, damage: 5 } });
    assert.deepStrictEqual(EFFECTS.slow, { durationMs: 2000, moveSpeedScale: 0.7 });
    assert.deepStrictEqual(ABILITY_EFFECTS, { twin_dragons: ["burn"], torrent: ["slow"] });
    assert.doesNotThrow(() => new StatusEffects({} as never), "the shipped config is valid");
  });

  it("shows on the player while active and wears off after its duration", () => {
    const { effects, join, advance } = fakeRoom();
    const player = join("a");

    assert.strictEqual(effects.apply("a", "shield"), true);
    assert.deepStrictEqual([...player.effects], ["shield"]);

    advance(450);
    assert.ok(effects.has("a", "shield"));
    advance(50);
    assert.strictEqual(effects.has("a", "shield"), false);
    assert.deepStrictEqual([...player.effects], []);
  });

  it("refreshes the timer when applied again, without listing it twice", () => {
    const { effects, join, advance } = fakeRoom();
    const player = join("a");

    effects.apply("a", "shield");
    advance(400);
    effects.apply("a", "shield");
    advance(400);
    assert.ok(effects.has("a", "shield"), "the second application restarted the 500 ms");
    assert.deepStrictEqual([...player.effects], ["shield"]);
  });

  it("ticks damage on its beat, credited to whoever applied it, up to its end", () => {
    const { effects, join, advance, hits } = fakeRoom();
    const player = join("a");

    effects.apply("a", "dot", FIREBALL_SOURCE);
    advance(2000);

    assert.strictEqual(hits.length, 4, "one tick per 250 ms of a 1000 ms effect");
    assert.ok(hits.every((h) => h.source === FIREBALL_SOURCE && h.options?.fromEffect === true));
    assert.strictEqual(player.hp, MAX_HP - 20);
  });

  it("scales the damage a player takes", () => {
    const { room, effects, join } = fakeRoom();
    assert.strictEqual(effects.apply("a", "shield"), false, "nobody there yet");
    const player = join("a");

    assert.strictEqual(effects.damageTakenScale("a"), 1);
    effects.apply("a", "shield");
    assert.strictEqual(effects.damageTakenScale("a"), 0.5);
    room.damage("a", 20);
    assert.strictEqual(player.hp, MAX_HP - 10);
  });

  it("applies an ability's on-hit effects, and only those", () => {
    const { effects, join } = fakeRoom({ fireball: ["dot"] });
    join("a");

    effects.applyOnHit("a", FIREBALL_SOURCE);
    effects.applyOnHit("a", { ...FIREBALL_SOURCE, ability: "sun_strike" });
    assert.ok(effects.has("a", "dot"));
    assert.strictEqual(effects.has("a", "shield"), false);
  });

  it("never applies to the dead, and a killing tick clears everything", () => {
    const { effects, join, advance } = fakeRoom();
    const player = join("a");

    player.hp = 3; // the shield halves the 5-point tick to 3 (rounded)
    effects.apply("a", "dot");
    effects.apply("a", "shield");
    advance(250);

    assert.strictEqual(player.hp, 0);
    assert.deepStrictEqual([...player.effects], []);
    assert.strictEqual(effects.apply("a", "dot"), false);
  });

  it("refuses unknown or malformed effects", () => {
    const { effects, zones } = fakeRoom();
    assert.throws(() => effects.apply("a", "nope"), /Unknown status effect "nope"/);
    assert.throws(() => zones.add({ x: 0, y: 0, radius: 10, durationMs: 100, effects: ["nope"] }), /nope/);
    assert.throws(() => fakeRoom({ fireball: ["nope"] }), /nope/);
    assert.throws(() => new StatusEffects({} as never, { bad: { durationMs: 0 } }), /durationMs/);
    assert.throws(() => new StatusEffects({} as never, { bad: { durationMs: 10, tick: { everyMs: 0, damage: 1 } } }), /everyMs/);
  });

  describe("ground zones", () => {
    it("apply their effects to living players standing inside, for as long as the zone lasts", () => {
      const { effects, zones, join, advance } = fakeRoom();
      const inside = join("inside", 100, 100);
      join("edge", 100 + 40 + PLAYER_HALF, 100);
      join("outside", 300, 300);
      const jumping = join("jumping", 100, 100);
      jumping.z = GROUND_ZONE_HEIGHT + 1;

      zones.add({ x: 100, y: 100, radius: 40, durationMs: 1000, effects: ["shield"], source: FIREBALL_SOURCE });
      advance(50);

      assert.ok(effects.has("inside", "shield"));
      assert.ok(effects.has("edge", "shield"), "touching the rim counts");
      assert.strictEqual(effects.has("outside", "shield"), false);
      assert.strictEqual(effects.has("jumping", "shield"), false, "a jump clears the zone");

      advance(900);
      assert.ok(effects.has("inside", "shield"), "standing in it keeps it on past its 500 ms");

      advance(600);
      assert.strictEqual(effects.has("inside", "shield"), false, "it wears off once the zone is gone");
      assert.deepStrictEqual([...inside.effects], []);
    });

    it("never apply to their exempt player", () => {
      const { effects, zones, join, advance } = fakeRoom();
      join("caster", 100, 100);
      join("other", 100, 100);

      zones.add({ x: 100, y: 100, radius: 40, durationMs: 1000, effects: ["shield"], source: FIREBALL_SOURCE, exemptId: "caster" });
      advance(50);

      assert.strictEqual(effects.has("caster", "shield"), false);
      assert.ok(effects.has("other", "shield"));
    });

    it("never apply to anyone digging in or under the ground", () => {
      const { effects, zones, join, advance } = fakeRoom();
      join("digging", 100, 100).effects.push("burrowing");
      join("under", 100, 100).effects.push("burrowed");

      zones.add({ x: 100, y: 100, radius: 40, durationMs: 1000, effects: ["shield"], source: FIREBALL_SOURCE });
      advance(50);

      assert.strictEqual(effects.has("digging", "shield"), false);
      assert.strictEqual(effects.has("under", "shield"), false);
    });
  });
});
