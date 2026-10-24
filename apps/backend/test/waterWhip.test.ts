import assert from "assert";
import type { Client, Clock } from "colyseus";

import { MyRoomState, Player, Wall } from "../src/rooms/schema/MyRoomState.js";
import { ARENA_WIDTH, EYE_HEIGHT, MAX_HP, PITCH_LIMIT, TICK_RATE } from "../src/shared/constants.js";
import { SERVER_MESSAGE } from "../src/shared/messages.js";
import type { DamageSource } from "../src/shared/combat.js";
import type { EffectId } from "../src/effects/effectConfig.js";
import { LIVE, type SeenAt, type SkillRoom } from "../src/skills/skillRoom.js";
import { WaterWhipSkill } from "../src/skills/waterWhip/waterWhip.js";
import {
  WATER_WHIP, WHIP_COMBO, nextWhipStep, whipStrike, type WaterWhipCast,
} from "../src/skills/waterWhip/waterWhipConfig.js";
import {
  WHIP_SHARD, distanceToWhipShardTarget, launchWhipShard, whipShardPosition, whipShardStepFrom, whipShardStruck,
  whipShardSurfaceHit, whipShardVelocity, type WhipShardCast, type WhipShardHit,
} from "../src/skills/waterWhip/whipShardConfig.js";

/** Aims along +x (at yaw 0 forward is -y; turning a quarter right faces +x). */
const EAST = -Math.PI / 2;
const DT = 1 / TICK_RATE;
const LEVEL_EAST = { yaw: EAST, pitch: 0 };

/** A room stand-in: real state, a clock the test moves by hand, and everything the skill does, recorded. */
function fakeRoom() {
  const state = new MyRoomState();
  const clock = { currentTime: 0 } as Clock;
  const hits: { sessionId: string; amount: number; source?: DamageSource }[] = [];
  const applied: { sessionId: string; id: EffectId; source?: DamageSource }[] = [];
  const casts: WaterWhipCast[] = [];
  const shards: WhipShardCast[] = [];
  const shatters: WhipShardHit[] = [];
  /** Lag compensation: how far behind each player saw everyone (ms), and everyone as they stood that long ago. */
  const lags = new Map<string, number>();
  const past = new Map<number, SeenAt>();
  /** Every rewind asked for, by lag: one per hit test. */
  const rewinds: number[] = [];
  const seenAgo = (lagMs: number) => {
    rewinds.push(lagMs);
    return past.get(lagMs) ?? LIVE;
  };
  const lagOf = (sessionId: string) => lags.get(sessionId) ?? 0;
  const room: SkillRoom = {
    state,
    clock,
    broadcast(type, message) {
      if (type === SERVER_MESSAGE.waterWhipCast) { casts.push(message as WaterWhipCast); }
      if (type === SERVER_MESSAGE.whipShardCast) { shards.push(message as WhipShardCast); }
      if (type === SERVER_MESSAGE.whipShardHit) { shatters.push(message as WhipShardHit); }
    },
    send() {},
    damage(sessionId, amount, source) {
      const player = state.players.get(sessionId);
      if (!player || player.hp <= 0) { return; }
      hits.push({ sessionId, amount, source });
      player.hp = Math.max(0, player.hp - amount);
    },
    removeEffect() {},
    applyEffect(sessionId, id, source) {
      const player = state.players.get(sessionId);
      if (!player || player.hp <= 0) { return false; }
      applied.push({ sessionId, id, source });
      return true;
    },
    addGroundZone: () => 0,
    seenBy: (sessionId) => seenAgo(lagOf(sessionId)),
    lagOf,
    seenAgo,
  };
  const skill = new WaterWhipSkill(room);
  const join = (sessionId: string, x: number, y: number, element = "water") => {
    const player = new Player({ name: sessionId, hp: MAX_HP, element, x, y, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, dashVx: 0, dashVy: 0, dashTime: 0, flightZ: 0, breathing: false, ready: false, wins: 0, ownerId: "" });
    state.players.set(sessionId, player);
    return player;
  };
  const client = (sessionId: string) => ({ sessionId }) as Client;
  /** Steps the skill like the room does, a tick at a time, moving the clock along. */
  const fly = (seconds: number) => {
    for (let t = 0; t < seconds; t += DT) {
      clock.currentTime += DT * 1000;
      skill.step(DT);
    }
  };
  /** Waits out the cooldown, well inside the combo's reset. */
  const ready = () => { clock.currentTime += WATER_WHIP.cooldownMs; };
  /** Two cracks from `id`, waiting out the cooldown after each: the next is the shard. */
  const twoLashes = (id: string) => {
    skill.cast(client(id), LEVEL_EAST);
    ready();
    skill.cast(client(id), LEVEL_EAST);
    ready();
  };
  return { state, skill, join, client, fly, ready, twoLashes, clock, hits, applied, casts, shards, shatters, lags, past, rewinds };
}

const sourceOf = (id: string): DamageSource => ({ id, name: id, ability: "water_whip" });

describe("water whip", () => {
  describe("config", () => {
    it("ships 10 damage a hit, 360 reach, a 750 ms cooldown and a 1.5 s combo reset", () => {
      assert.strictEqual(WATER_WHIP.damage, 10);
      assert.strictEqual(WATER_WHIP.range, 360);
      assert.strictEqual(WATER_WHIP.cooldownMs, 750);
      assert.strictEqual(WATER_WHIP.comboResetMs, 1500);
      assert.deepStrictEqual(WHIP_COMBO.map((hit) => [hit.hand, hit.effect]), [
        ["right", "whip_slow_10"], ["left", "whip_slow_15"], ["center", "whip_slow_10"],
      ]);
    });

    it("steps through the combo, starting over after the shard or a long pause", () => {
      assert.strictEqual(nextWhipStep(undefined, 0), 0);
      assert.strictEqual(nextWhipStep({ step: 0, at: 0 }, 750), 1);
      assert.strictEqual(nextWhipStep({ step: 1, at: 0 }, WATER_WHIP.comboResetMs), 2, "right at the limit still counts");
      assert.strictEqual(nextWhipStep({ step: 2, at: 0 }, 750), 0);
      assert.strictEqual(nextWhipStep({ step: 1, at: 0 }, WATER_WHIP.comboResetMs + 1), 0);
    });

    it("lashes never strike whoever is spared", () => {
      const caster = { x: 400, y: 300, z: 0 };
      const players: [string, { x: number; y: number; z: number; hp: number }][] = [
        ["near", { x: 400, y: 250, z: 0, hp: MAX_HP }], ["far", { x: 400, y: 200, z: 0, hp: MAX_HP }],
      ];
      assert.strictEqual(whipStrike("me", caster, { yaw: 0, pitch: 0 }, players).hitId, "near");
      assert.strictEqual(whipStrike("me", caster, { yaw: 0, pitch: 0 }, players, [], new Set(["near"])).hitId, "far");
    });

    it("launches the shard from the centre of the eyes, along the view, at full speed", () => {
      const launch = launchWhipShard({ x: 100, y: 300, z: 0 }, LEVEL_EAST);
      assert.ok(Math.abs(launch.x - 100) < 1e-9 && Math.abs(launch.y - 300) < 1e-9, "no hand offset");
      assert.strictEqual(launch.z, EYE_HEIGHT);
      assert.ok(Math.abs(launch.vx - WHIP_SHARD.speed) < 1e-9);
      assert.ok(Math.abs(launch.vy) < 1e-9 && launch.vz === 0);

      const up = launchWhipShard({ x: 100, y: 300, z: 0 }, { yaw: 0, pitch: 10 });
      assert.ok(Math.abs(Math.hypot(up.vx, up.vy, up.vz) - WHIP_SHARD.speed) < 1e-6);
      assert.ok(Math.abs(up.vz - Math.sin(PITCH_LIMIT) * WHIP_SHARD.speed) < 1e-6, "pitch is clamped like the camera's");
    });

    it("flies the shard in a light arc: barely dropping across the arena", () => {
      const launch = launchWhipShard({ x: 0, y: 300, z: 0 }, LEVEL_EAST);
      assert.deepStrictEqual(whipShardPosition(launch, 0), { x: launch.x, y: launch.y, z: launch.z });
      const across = ARENA_WIDTH / WHIP_SHARD.speed;
      assert.ok(launch.z - whipShardPosition(launch, across).z < 30, "drops less than a body's height crossing the arena");
      assert.ok(whipShardVelocity(launch, 1).z < 0, "and noses down as it falls");
    });

    it("never steps a shard further than its own radius", () => {
      for (const t of [0, 0.5, 1.4]) {
        const step = whipShardStepFrom(t, DT);
        const a = launchWhipShard({ x: 400, y: 300, z: 0 }, { yaw: 1, pitch: -1 });
        const from = whipShardPosition(a, t);
        const to = whipShardPosition(a, t + step);
        assert.ok(Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z) <= WHIP_SHARD.radius + 1e-9);
      }
    });

    it("shatters shards against the arena walls and the floor, on the surface", () => {
      assert.strictEqual(whipShardSurfaceHit({ x: 400, y: 300, z: 30 }), null);
      assert.deepStrictEqual(whipShardSurfaceHit({ x: ARENA_WIDTH + 3, y: 300, z: 30 }), { x: ARENA_WIDTH - WHIP_SHARD.radius, y: 300, z: 30 });
      assert.deepStrictEqual(whipShardSurfaceHit({ x: 400, y: 300, z: -2 }), { x: 400, y: 300, z: WHIP_SHARD.radius });
    });

    it("a shard strikes the closest living body it touches, never the thrower's nor the spared", () => {
      const at = { x: 200, y: 300, z: 20 };
      assert.strictEqual(distanceToWhipShardTarget({ x: 200, y: 300, z: 0 }, at), 0);
      const players: [string, { x: number; y: number; z: number; hp: number }][] = [
        ["caster", { x: 200, y: 300, z: 0, hp: MAX_HP }],
        ["dead", { x: 200, y: 300, z: 0, hp: 0 }],
        ["grazed", { x: 200, y: 300 + 12 + 4, z: 0, hp: MAX_HP }],
        ["centred", { x: 205, y: 300, z: 0, hp: MAX_HP }],
        ["far", { x: 260, y: 300, z: 0, hp: MAX_HP }],
      ];
      assert.strictEqual(whipShardStruck("caster", at, players), "centred");
      assert.strictEqual(whipShardStruck("caster", at, players, new Set(["centred"])), "grazed");
      assert.strictEqual(whipShardStruck("caster", at, players.filter(([id]) => id !== "centred")), "grazed");
      assert.strictEqual(whipShardStruck("caster", at, [players[0], players[1], players[4]]), undefined);
      assert.strictEqual(whipShardStruck("caster", { x: 200, y: 300, z: 44 + 6 }, [players[3]]), undefined, "flies over a head");
    });
  });

  describe("server skill", () => {
    it("only water mages with Water Whip in their kit, alive, may crack it", () => {
      const { skill, join, client, casts } = fakeRoom();
      join("fire", 100, 100, "fire");
      join("dead", 100, 200).hp = 0;
      skill.cast(client("fire"), { yaw: 0, pitch: 0 });
      skill.cast(client("dead"), { yaw: 0, pitch: 0 });
      skill.cast(client("nobody"), { yaw: 0, pitch: 0 });
      assert.strictEqual(casts.length, 0);
    });

    it("drops junk payloads silently, without starting the cooldown", () => {
      const { skill, join, client, casts } = fakeRoom();
      join("caster", 100, 300);
      for (const junk of [undefined, null, 5, "x", {}, { yaw: 1 }, { yaw: "1", pitch: 0 }, { yaw: NaN, pitch: 0 }, { yaw: 0, pitch: Infinity }]) {
        assert.doesNotThrow(() => skill.cast(client("caster"), junk));
      }
      assert.strictEqual(casts.length, 0);
      skill.cast(client("caster"), LEVEL_EAST);
      assert.strictEqual(casts.length, 1);
    });

    it("lashes right, then left, then throws a shard — each hit 10 damage and its slow", () => {
      const { skill, join, client, fly, ready, clock, hits, applied, casts, shards } = fakeRoom();
      join("caster", 100, 300);
      join("target", 300, 300);
      const source = sourceOf("caster");

      skill.cast(client("caster"), LEVEL_EAST);
      assert.deepStrictEqual(casts[0], {
        casterId: "caster", cooldownMs: WATER_WHIP.cooldownMs, step: 0, hand: "right",
        ...whipStrike("caster", { x: 100, y: 300, z: 0 }, LEVEL_EAST, [["target", { x: 300, y: 300, z: 0, hp: MAX_HP }]]),
      });
      ready();
      skill.cast(client("caster"), LEVEL_EAST);
      assert.deepStrictEqual([casts[1].step, casts[1].hand, casts[1].hitId], [1, "left", "target"]);
      assert.deepStrictEqual(hits, [{ sessionId: "target", amount: 10, source }, { sessionId: "target", amount: 10, source }]);
      assert.deepStrictEqual(applied, [{ sessionId: "target", id: "whip_slow_10", source }, { sessionId: "target", id: "whip_slow_15", source }]);

      ready();
      skill.cast(client("caster"), LEVEL_EAST);
      const launch = launchWhipShard({ x: 100, y: 300, z: 0 }, LEVEL_EAST);
      assert.deepStrictEqual(casts[2], {
        casterId: "caster", cooldownMs: WATER_WHIP.comboResetMs, step: 2, hand: "center", end: { x: launch.x, y: launch.y, z: launch.z },
      });
      assert.deepStrictEqual(shards, [{ id: 1, casterId: "caster", ...launch }]);
      assert.strictEqual(hits.length, 2, "the shard hasn't arrived yet");
      fly(0.5);
      assert.deepStrictEqual(hits[2], { sessionId: "target", amount: 10, source });
      assert.deepStrictEqual(applied[2], { sessionId: "target", id: "whip_slow_10", source });

      clock.currentTime += WATER_WHIP.comboResetMs;
      skill.cast(client("caster"), LEVEL_EAST);
      assert.strictEqual(casts[3].step, 0, "after the shard, the combo starts over");
    });

    it("holds the next hit for the cooldown, and starts the combo over after a pause", () => {
      const { skill, join, client, clock, casts } = fakeRoom();
      join("caster", 100, 300);
      skill.cast(client("caster"), LEVEL_EAST);
      clock.currentTime += WATER_WHIP.cooldownMs - 1;
      skill.cast(client("caster"), LEVEL_EAST);
      assert.strictEqual(casts.length, 1, "too early");
      clock.currentTime += 1;
      skill.cast(client("caster"), LEVEL_EAST);
      assert.deepStrictEqual(casts.map((c) => c.step), [0, 1]);

      clock.currentTime += WATER_WHIP.comboResetMs + 1;
      skill.cast(client("caster"), LEVEL_EAST);
      assert.deepStrictEqual(casts.map((c) => c.step), [0, 1, 0], "too long a pause: right hand again");
    });

    it("holds the next combo for the longer combo reset after the shard", () => {
      const { skill, join, client, clock, twoLashes, casts } = fakeRoom();
      join("caster", 100, 300);
      twoLashes("caster");
      skill.cast(client("caster"), LEVEL_EAST);
      assert.strictEqual(casts[2].step, 2);

      clock.currentTime += WATER_WHIP.comboResetMs - 1;
      skill.cast(client("caster"), LEVEL_EAST);
      assert.strictEqual(casts.length, 3, "the usual cooldown is not enough after the shard");
      clock.currentTime += 1;
      skill.cast(client("caster"), LEVEL_EAST);
      assert.strictEqual(casts[3].step, 0);
      assert.strictEqual(casts[3].cooldownMs, WATER_WHIP.cooldownMs, "the lashes are quick again");
    });

    it("reaches twice as far as before", () => {
      const { skill, join, client, casts } = fakeRoom();
      join("caster", 100, 300);
      join("target", 100 + 340, 300);
      skill.cast(client("caster"), LEVEL_EAST);
      assert.strictEqual(casts[0].hitId, "target");
    });

    it("lashes whoever the caster saw it reach, not where they have moved on to since", () => {
      const { skill, join, client, casts, lags, past } = fakeRoom();
      join("caster", 100, 300);
      const target = join("target", 200, 300);
      // On the caster's screen the target still stood in the lash's path; by now they've stepped aside.
      lags.set("caster", 150);
      past.set(150, (player) => (player === target ? { x: 200, y: 300, z: 0 } : player));
      target.y = 300 + 200;
      skill.cast(client("caster"), LEVEL_EAST);
      assert.strictEqual(casts[0].hitId, "target");
      assert.deepStrictEqual(casts[0].end, { x: 200, y: 300, z: EYE_HEIGHT }, "the lash ends where the caster saw them");
    });

    it("a clone's lash strikes where everyone is now: no one's view to compensate for", () => {
      const { skill, join, lags, past } = fakeRoom();
      const target = join("target", 200, 300);
      lags.set("clone", 150);
      past.set(150, () => ({ x: 200, y: 300, z: 0 }));
      target.y = 300 + 200;
      const source = { id: "owner", name: "owner", ability: "water_whip" } as const;
      assert.strictEqual(skill.attack("clone", { x: 100, y: 300, z: 0 }, LEVEL_EAST, source), true);
      assert.strictEqual(target.hp, MAX_HP);
    });

    it("the shard strikes whoever the thrower saw in its path, for its whole flight", () => {
      const { skill, join, client, fly, twoLashes, lags, past, rewinds, hits, shatters } = fakeRoom();
      join("caster", 100, 300);
      const target = join("target", 400, 300);
      twoLashes("caster");
      // The thrower saw the target in the shard's path; by now they've stepped well aside.
      lags.set("caster", 200);
      past.set(200, (player) => (player === target ? { x: 400, y: 300, z: 0 } : player));
      target.y = 300 + 200;
      rewinds.length = 0;
      hits.length = 0;
      skill.cast(client("caster"), LEVEL_EAST);
      fly(1);
      assert.deepStrictEqual(hits, [{ sessionId: "target", amount: WATER_WHIP.damage, source: sourceOf("caster") }]);
      assert.strictEqual(shatters[0].hitId, "target");
      assert.ok(Math.abs(shatters[0].y - 300) < 1e-6, "shatters where the thrower saw them");
      assert.ok(rewinds.length > 1 && rewinds.every((lag) => lag === 200), "every hit test of the flight reads the thrower's lag");
    });

    it("a shard thrown with no lag strikes where everyone is now", () => {
      const { skill, join, fly, twoLashes, past, rewinds, hits, shatters } = fakeRoom();
      join("caster", 100, 300);
      const target = join("target", 400, 300);
      twoLashes("caster");
      // Someone else's lag says the target still stands in the path; the shard's thrower had none.
      past.set(200, (player) => (player === target ? { x: 400, y: 300, z: 0 } : player));
      target.y = 300 + 200;
      rewinds.length = 0;
      hits.length = 0;
      skill.attack("caster", { x: 100, y: 300, z: 0 }, LEVEL_EAST, sourceOf("caster"));
      fly(1);
      assert.strictEqual(hits.length, 0);
      assert.ok(!("hitId" in shatters[0]), "flies past where the target used to be");
      assert.ok(rewinds.length > 0 && rewinds.every((lag) => lag === 0));
    });

    it("a killing hit slows no one", () => {
      const { skill, join, client, hits, applied } = fakeRoom();
      join("caster", 100, 300);
      join("target", 200, 300).hp = WATER_WHIP.damage;
      skill.cast(client("caster"), LEVEL_EAST);
      assert.strictEqual(hits.length, 1);
      assert.strictEqual(applied.length, 0);
    });

    it("lashes and shards pass the untargetable by", () => {
      const { skill, join, client, fly, twoLashes, hits, shatters } = fakeRoom();
      join("caster", 100, 300);
      join("under", 200, 300).effects.push("burrowed");
      join("behind", 300, 300);
      twoLashes("caster");
      skill.cast(client("caster"), LEVEL_EAST);
      fly(0.5);
      assert.deepStrictEqual(hits.map((h) => h.sessionId), ["behind", "behind", "behind"]);
      assert.strictEqual(shatters[0].hitId, "behind");
    });

    it("the shard strikes the first living enemy in its path, alone", () => {
      const { skill, join, client, fly, twoLashes, hits, shatters } = fakeRoom();
      join("caster", 100, 300);
      join("corpse", 200, 300).hp = 0;
      join("first", 300, 300);
      join("behind", 360, 300);
      twoLashes("caster");
      hits.length = 0;
      skill.cast(client("caster"), LEVEL_EAST);
      fly(1);
      assert.deepStrictEqual(hits, [{ sessionId: "first", amount: WATER_WHIP.damage, source: sourceOf("caster") }]);
      assert.strictEqual(shatters.length, 1);
      const [hit] = shatters;
      assert.strictEqual(hit.id, 1);
      assert.strictEqual(hit.hitId, "first");
      assert.ok(Math.abs(hit.x - (300 - 12 - WHIP_SHARD.radius)) <= WHIP_SHARD.radius, "shatters at the body's front");
    });

    it("the shard takes a while to get there: fast, not instant", () => {
      const { skill, join, client, fly, twoLashes, hits } = fakeRoom();
      join("caster", 50, 300);
      twoLashes("caster");
      join("target", 750, 300);
      skill.cast(client("caster"), LEVEL_EAST);
      fly(0.3);
      assert.strictEqual(hits.length, 0);
      fly(0.3);
      assert.strictEqual(hits.length, 1);
    });

    it("the shard shatters on the far wall with no one in the way, hurting no one", () => {
      const { skill, join, client, fly, twoLashes, hits, applied, shatters } = fakeRoom();
      join("caster", 100, 300);
      join("aside", 300, 450);
      twoLashes("caster");
      skill.cast(client("caster"), LEVEL_EAST);
      fly(1);
      assert.strictEqual(hits.length + applied.length, 0);
      assert.strictEqual(shatters.length, 1);
      assert.strictEqual(shatters[0].x, ARENA_WIDTH - WHIP_SHARD.radius);
      assert.ok(!("hitId" in shatters[0]), "a miss says nothing about a target");
    });

    it("the shard shatters on a raised wall, sparing whoever is behind it", () => {
      const { state, skill, join, client, fly, twoLashes, hits, shatters } = fakeRoom();
      join("caster", 100, 300);
      join("behind", 500, 300);
      twoLashes("caster");
      hits.length = 0;
      state.walls.set("wall", new Wall({ ownerId: "someone", kind: "wall", x: 400, y: 300, angle: Math.PI / 2, halfLength: 50, halfThickness: 5, height: 100 }));
      skill.cast(client("caster"), LEVEL_EAST);
      fly(1);
      assert.strictEqual(hits.length, 0);
      assert.strictEqual(shatters.length, 1);
      assert.ok(shatters[0].x <= 400 && shatters[0].x >= 390 - WHIP_SHARD.radius, "against the wall's near face");
    });

    it("the shard shatters on the floor when thrown down, and melts when thrown at the sky", () => {
      const { skill, join, client, fly, twoLashes, ready, shatters } = fakeRoom();
      join("caster", 100, 300);
      twoLashes("caster");
      skill.cast(client("caster"), { yaw: EAST, pitch: -0.6 });
      fly(1);
      assert.strictEqual(shatters.length, 1);
      assert.strictEqual(shatters[0].z, WHIP_SHARD.radius);

      ready();
      twoLashes("caster");
      skill.cast(client("caster"), { yaw: 0, pitch: Math.PI / 2 });
      fly(WHIP_SHARD.lifetimeMs / 1000 + 1);
      assert.strictEqual(shatters.length, 1);
    });

    it("a fresh round: cooldowns and combos go, and shards in the air vanish", () => {
      const { skill, join, client, fly, twoLashes, casts, shatters } = fakeRoom();
      join("caster", 100, 300);
      twoLashes("caster");
      join("target", 700, 300);
      skill.cast(client("caster"), LEVEL_EAST);
      skill.reset();
      fly(1);
      assert.strictEqual(shatters.length, 0);
      skill.cast(client("caster"), LEVEL_EAST);
      assert.strictEqual(casts.length, 4, "ready again right away");
      assert.strictEqual(casts[3].step, 0);
    });

    it("an attacker leaving: their shard still lands, their cooldown and combo go", () => {
      const { skill, join, client, fly, twoLashes, casts, hits } = fakeRoom();
      join("caster", 100, 300);
      twoLashes("caster");
      join("target", 300, 300);
      skill.cast(client("caster"), LEVEL_EAST);
      skill.remove("caster");
      fly(1);
      assert.strictEqual(hits.length, 1);

      skill.cast(client("caster"), { yaw: 0, pitch: 0 });
      skill.remove("caster");
      skill.cast(client("caster"), { yaw: 0, pitch: 0 });
      assert.deepStrictEqual(casts.slice(-2).map((c) => c.step), [0, 0], "ready at once, and the right hand again");
    });
  });

  describe("attack (for anything that cracks a whip, like a water clone)", () => {
    it("keeps its own cooldown and combo per attacker id, credits the source given, spares `ignore`", () => {
      const { skill, join, client, fly, ready, hits, applied, casts, shatters } = fakeRoom();
      join("owner", 100, 400);
      join("clone", 100, 300);
      join("friend", 200, 300);
      join("enemy", 300, 300);
      const source = { id: "owner", name: "owner", ability: "water_whip" } as const;
      const spare = new Set(["owner", "friend"]);

      assert.strictEqual(skill.attack("clone", { x: 100, y: 300, z: 0 }, LEVEL_EAST, source, spare), true);
      assert.strictEqual(skill.attack("clone", { x: 100, y: 300, z: 0 }, LEVEL_EAST, source, spare), false, "on cooldown");
      assert.deepStrictEqual([casts[0].casterId, casts[0].step, casts[0].hitId], ["clone", 0, "enemy"]);
      // The owner's own whip is separate.
      skill.cast(client("owner"), { yaw: Math.PI, pitch: 0 });
      assert.deepStrictEqual([casts[1].casterId, casts[1].step], ["owner", 0]);

      ready();
      skill.attack("clone", { x: 100, y: 300, z: 0 }, LEVEL_EAST, source, spare);
      ready();
      skill.attack("clone", { x: 100, y: 300, z: 0 }, LEVEL_EAST, source, spare);
      assert.deepStrictEqual(casts.slice(2).map((c) => [c.casterId, c.step]), [["clone", 1], ["clone", 2]]);
      fly(0.5);
      assert.strictEqual(shatters[0].hitId, "enemy", "the shard flies past the spared too");
      assert.deepStrictEqual(hits.map((h) => [h.sessionId, h.source]), [["enemy", source], ["enemy", source], ["enemy", source]]);
      assert.deepStrictEqual(applied.map((a) => a.id), ["whip_slow_10", "whip_slow_15", "whip_slow_10"]);

      skill.remove("clone");
      assert.strictEqual(skill.attack("clone", { x: 100, y: 300, z: 0 }, LEVEL_EAST, source, spare), true, "removed: ready again");
      assert.strictEqual(casts.at(-1)!.step, 0);

      // A damage given overrides the whip's own, for the shard too.
      ready();
      skill.attack("clone", { x: 100, y: 300, z: 0 }, LEVEL_EAST, source, spare, 4);
      assert.strictEqual(hits.at(-1)!.amount, 4);
    });
  });
});
