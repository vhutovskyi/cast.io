import assert from "assert";
import type { Client, Clock } from "colyseus";
import { LIVE, type SeenAt, type SeenPoint } from "../src/skills/skillRoom.js";

import { MyRoomState, Player, Wall } from "../src/rooms/schema/MyRoomState.js";
import { MAX_HP, PLAYER_HALF } from "../src/shared/constants.js";
import type { DamageSource } from "../src/shared/combat.js";
import { SERVER_MESSAGE } from "../src/shared/messages.js";
import { canCast, moveLimits, EFFECTS, type EffectId } from "../src/effects/effectConfig.js";
import { stepEntity } from "../src/shared/movement.js";
import { RuptureSkill } from "../src/skills/rupture/rupture.js";
import {
  RUPTURE, RUPTURE_TRAVEL_MS, inRuptureFan, ruptureBlocked, ruptureCorners, ruptureHalfWidth, ruptureLocal,
  ruptureReaches, ruptureWorld, type RuptureCast,
} from "../src/skills/rupture/ruptureConfig.js";

/** One server tick, in seconds. */
const DT = 1 / 30;

/**
 * A room stand-in: real state, a clock the test moves by hand, and records of
 * what the skill asked the room to do (no Colyseus server is booted).
 */
function fakeRoom() {
  const state = new MyRoomState();
  const clock = { currentTime: 0 } as Clock;
  const hits: { sessionId: string; amount: number; source?: DamageSource; at: number }[] = [];
  const applied: { sessionId: string; id: EffectId; source?: DamageSource; durationMs?: number }[] = [];
  const sent: { type: string; message: unknown }[] = [];
  /**
   * Lag compensation, set by hand: how far behind the caster saw everyone
   * (`lagOf`), and where players stood that long ago (`seenAgo`); anyone not
   * listed, or a lag of 0, reads live. Every lag asked for is recorded.
   */
  const lag = { ms: 0, past: new Map<Player, SeenPoint>(), asked: [] as number[] };
  const room = {
    state,
    clock,
    broadcast(type: string, message: unknown) { sent.push({ type, message }); },
    send() {},
    damage(sessionId: string, amount: number, source?: DamageSource) {
      const player = state.players.get(sessionId);
      if (!player || player.hp <= 0) { return; }
      hits.push({ sessionId, amount, source, at: clock.currentTime });
      player.hp = Math.max(0, player.hp - amount);
    },
    removeEffect() {},
    applyEffect(sessionId: string, id: EffectId, source?: DamageSource, durationMs?: number) {
      const player = state.players.get(sessionId);
      if (!player || player.hp <= 0) { return false; }
      applied.push({ sessionId, id, source, durationMs });
      if (!player.effects.includes(id)) { player.effects.push(id); }
      return true;
    },
    addGroundZone() { return 0; },
    seenBy: () => LIVE,
    lagOf: () => lag.ms,
    canAct: (sessionId: string) => (state.players.get(sessionId)?.hp ?? 0) > 0,
    seenAgo(lagMs: number): SeenAt {
      lag.asked.push(lagMs);
      return lagMs > 0 ? (player) => lag.past.get(player) ?? player : LIVE;
    },
  };
  const skill = new RuptureSkill(room);
  const join = (sessionId: string, x: number, y: number, element = "earth") => {
    const player = new Player({ name: sessionId, hp: MAX_HP, element, x, y, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, dashVx: 0, dashVy: 0, dashTime: 0, flightZ: 0, breathing: false, ready: false, wins: 0, ownerId: "" });
    state.players.set(sessionId, player);
    return player;
  };
  const client = (sessionId: string) => ({ sessionId }) as Client;
  /** Runs `ms` worth of server ticks. */
  const run = (ms: number) => {
    for (let t = 0; t < ms; t += DT * 1000) {
      clock.currentTime += DT * 1000;
      skill.step(DT);
    }
  };
  const casts = () => sent.filter((m) => m.type === SERVER_MESSAGE.ruptureCast).map((m) => m.message as RuptureCast);
  return { state, skill, join, client, run, casts, hits, applied, clock, lag };
}

/** Facing straight ahead at yaw 0 is -y. */
const AHEAD = { yaw: 0 };
const ORIGIN = { x: 400, y: 500 };

describe("rupture", () => {
  describe("shared rules", () => {
    it("measures along the facing and across it, both ways", () => {
      assert.deepStrictEqual(ruptureLocal(ORIGIN, 0, { x: 430, y: 400 }), { along: 100, across: 30 });
      const there = ruptureWorld(ORIGIN, 1.2, 150, -40);
      const back = ruptureLocal(ORIGIN, 1.2, there);
      assert.ok(Math.abs(back.along - 150) < 1e-9 && Math.abs(back.across + 40) < 1e-9);
    });

    it("is a fan: narrow at the caster's feet, wider with distance", () => {
      assert.strictEqual(ruptureHalfWidth(0), RUPTURE.baseHalfWidth);
      assert.ok(ruptureHalfWidth(200) > ruptureHalfWidth(100) && ruptureHalfWidth(100) > ruptureHalfWidth(20));
      const expected = RUPTURE.baseHalfWidth + RUPTURE.range * Math.tan((RUPTURE.halfAngleDeg * Math.PI) / 180);
      assert.ok(Math.abs(ruptureHalfWidth(RUPTURE.range) - expected) < 1e-9);
      assert.strictEqual(ruptureHalfWidth(RUPTURE.range + 100), ruptureHalfWidth(RUPTURE.range), "no wider past its range");

      // 30 units to the side: outside close in, inside further out.
      assert.strictEqual(inRuptureFan(ORIGIN, 0, { x: 430, y: 490 }), false);
      assert.strictEqual(inRuptureFan(ORIGIN, 0, { x: 430, y: 420 }), true);
    });

    it("is cut off flat at its range, and never reaches behind or beside the caster", () => {
      assert.strictEqual(inRuptureFan(ORIGIN, 0, { x: 400, y: 500 - RUPTURE.range + 1 }), true);
      assert.strictEqual(inRuptureFan(ORIGIN, 0, { x: 400, y: 500 - RUPTURE.range - 1 }), false);
      assert.strictEqual(inRuptureFan(ORIGIN, 0, { x: 400, y: 500 - RUPTURE.range - 5 }, PLAYER_HALF), true, "a body's edge on the far line counts");
      assert.strictEqual(inRuptureFan(ORIGIN, 0, { x: 400, y: 520 }, PLAYER_HALF), false, "behind");
      assert.strictEqual(inRuptureFan(ORIGIN, 0, { x: 600, y: 500 }, PLAYER_HALF), false, "beside");
      assert.strictEqual(inRuptureFan(ORIGIN, 0, { x: 600, y: 300 }), false, "ahead, but outside the angle");
      // Turned: at yaw -π/2 forward is +x.
      assert.strictEqual(inRuptureFan(ORIGIN, -Math.PI / 2, { x: 600, y: 500 }), true);
    });

    it("has four corners: the narrow base and the wide far edge", () => {
      const [baseLeft, baseRight, farRight, farLeft] = ruptureCorners(ORIGIN, 0);
      assert.ok(Math.abs(baseLeft.x - (400 - RUPTURE.baseHalfWidth)) < 1e-9 && Math.abs(baseLeft.y - 500) < 1e-9);
      assert.ok(Math.abs(baseRight.x - (400 + RUPTURE.baseHalfWidth)) < 1e-9);
      assert.ok(Math.abs(farRight.y - (500 - RUPTURE.range)) < 1e-9 && Math.abs(farLeft.y - (500 - RUPTURE.range)) < 1e-9);
      assert.ok(Math.abs(farRight.x - farLeft.x - 2 * ruptureHalfWidth(RUPTURE.range)) < 1e-9);
      assert.strictEqual(RUPTURE_TRAVEL_MS, ((RUPTURE.range + PLAYER_HALF) / RUPTURE.waveSpeed) * 1000);
    });

    it("reaches a living body on the ground as its front crosses it, unless a wall is in the way", () => {
      const body = (z = 0, hp = MAX_HP) => ({ x: 400, y: 300, z, hp });
      assert.strictEqual(ruptureReaches(ORIGIN, 0, 0, 100, body()), false, "not there yet");
      assert.strictEqual(ruptureReaches(ORIGIN, 0, 180, 210, body()), true);
      assert.strictEqual(ruptureReaches(ORIGIN, 0, 240, 270, body()), false, "already passed");
      assert.strictEqual(ruptureReaches(ORIGIN, 0, 180, 210, body(RUPTURE.groundReach)), true, "just off the floor");
      assert.strictEqual(ruptureReaches(ORIGIN, 0, 180, 210, body(RUPTURE.groundReach + 1)), false, "jumped over it");
      assert.strictEqual(ruptureReaches(ORIGIN, 0, 180, 210, body(0, 0)), false, "the dead");

      const wall = { x: 400, y: 400, angle: 0, halfLength: 40, halfThickness: 5, height: 40 };
      assert.strictEqual(ruptureBlocked(ORIGIN, body(), [wall]), true);
      assert.strictEqual(ruptureReaches(ORIGIN, 0, 180, 210, body(), [wall]), false);
      assert.strictEqual(ruptureBlocked(ORIGIN, { x: 520, y: 320 }, [wall]), false, "round the wall's end");
    });
  });

  describe("stunned", () => {
    it("can't walk, jump or cast", () => {
      assert.strictEqual(EFFECTS.stunned.durationMs, RUPTURE.stunMs);
      assert.deepStrictEqual(moveLimits(["stunned"]), { speedScale: 0, canJump: false });
      assert.strictEqual(canCast(["stunned"]), false);
      assert.strictEqual(canCast([]), true);
    });

    it("keeps a stunned player in place, whatever they press", () => {
      const entity = { x: 400, y: 300, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, dashVx: 0, dashVy: 0, dashTime: 0, flightZ: 0 };
      for (let i = 0; i < 30; i++) {
        stepEntity(entity, { moveX: 1, moveY: -1, yaw: 0, jump: true, breath: false }, DT, moveLimits(["stunned"]));
      }
      assert.deepStrictEqual([entity.x, entity.y, entity.z], [400, 300, 0]);
    });
  });

  describe("server skill", () => {
    it("tears the ground open for an earth mage and tells everyone where and which way", () => {
      const { skill, join, client, casts } = fakeRoom();
      join("caster", 400, 500);

      skill.cast(client("caster"), { yaw: 0.5 });
      const [cast] = casts();
      assert.deepStrictEqual({ ...cast, id: 0 }, { id: 0, casterId: "caster", cooldownMs: RUPTURE.cooldownMs, x: 400, y: 500, yaw: 0.5 });
    });

    it("drops casts from other elements, the dead, strangers and junk", () => {
      const { skill, join, client, casts } = fakeRoom();
      join("fire", 400, 500, "fire");
      join("dead", 400, 500).hp = 0;
      join("caster", 400, 500);

      skill.cast(client("fire"), AHEAD);
      skill.cast(client("dead"), AHEAD);
      skill.cast(client("nobody"), AHEAD);
      for (const junk of [undefined, null, 5, "x", {}, { yaw: "0" }, { yaw: NaN }, { yaw: Infinity }]) {
        skill.cast(client("caster"), junk);
      }
      assert.strictEqual(casts().length, 0);
    });

    it("refuses a second cast until the cooldown is over", () => {
      const { skill, join, client, casts, clock } = fakeRoom();
      join("caster", 400, 500);

      skill.cast(client("caster"), AHEAD);
      clock.currentTime = RUPTURE.cooldownMs - 1;
      skill.cast(client("caster"), AHEAD);
      assert.strictEqual(casts().length, 1);
      clock.currentTime = RUPTURE.cooldownMs;
      skill.cast(client("caster"), AHEAD);
      assert.strictEqual(casts().length, 2);
    });

    it("reaches near bodies first and far ones later, striking and stunning each once", () => {
      const { skill, join, client, run, hits, applied } = fakeRoom();
      join("caster", 400, 500);
      const near = join("near", 400, 440);
      const far = join("far", 460, 300);

      skill.cast(client("caster"), AHEAD);
      run(RUPTURE.windupMs - 50);
      assert.deepStrictEqual(hits, [], "nothing during the wind-up, standing right in front");
      run(120);
      assert.deepStrictEqual(hits.map((h) => h.sessionId), ["near"], "the front has only come ~60 units");

      run(500);
      assert.deepStrictEqual(hits.map((h) => h.sessionId), ["near", "far"]);
      const [nearHit, farHit] = hits;
      assert.ok(farHit.at - nearHit.at >= ((200 - 60 - DT * RUPTURE.waveSpeed) / RUPTURE.waveSpeed) * 1000, "the far one later, at the wave's speed");
      assert.deepStrictEqual(hits.map((h) => [h.amount, h.source?.ability, h.source?.id]), [
        [RUPTURE.damage, "rupture", "caster"], [RUPTURE.damage, "rupture", "caster"],
      ]);
      assert.deepStrictEqual(applied.map((a) => [a.sessionId, a.id, a.durationMs]), [
        ["near", "stunned", RUPTURE.stunMs], ["far", "stunned", RUPTURE.stunMs],
      ]);
      assert.deepStrictEqual([...near.effects], ["stunned"]);
      assert.strictEqual(far.hp, MAX_HP - RUPTURE.damage);

      run(2000);
      assert.strictEqual(hits.length, 2, "one wave, one hit each");
    });

    it("spares whoever is outside the fan: beside, behind, beyond its range", () => {
      const { skill, join, client, run, hits } = fakeRoom();
      join("caster", 400, 500);
      join("beside", 470, 480);
      join("behind", 400, 560);
      join("beyond", 400, 500 - RUPTURE.range - PLAYER_HALF - 5);
      join("wide", 600, 330);

      skill.cast(client("caster"), AHEAD);
      run(1000);
      assert.strictEqual(hits.length, 0);
    });

    it("passes under a body in the air: a jump dodges it", () => {
      const { skill, join, client, run, hits } = fakeRoom();
      join("caster", 400, 500);
      join("jumper", 400, 350).z = RUPTURE.groundReach + 10;

      skill.cast(client("caster"), AHEAD);
      run(1000);
      assert.strictEqual(hits.length, 0);
    });

    it("never strikes its caster, nor the dead", () => {
      const { skill, join, client, run, hits, applied } = fakeRoom();
      join("caster", 400, 500);
      join("corpse", 400, 400).hp = 0;

      skill.cast(client("caster"), AHEAD);
      run(1000);
      assert.strictEqual(hits.length, 0);
      assert.strictEqual(applied.length, 0);
    });

    it("is stopped by a raised wall for whoever is behind it", () => {
      const { state, skill, join, client, run, hits } = fakeRoom();
      join("caster", 400, 500);
      join("shielded", 400, 300);
      join("exposed", 520, 320);
      state.walls.set("wall", new Wall({ ownerId: "someone", kind: "wall", x: 400, y: 400, angle: 0, halfLength: 40, halfThickness: 5, height: 40 }));

      skill.cast(client("caster"), AHEAD);
      run(1000);
      assert.deepStrictEqual(hits.map((h) => h.sessionId), ["exposed"]);
    });

    it("runs out from where it was cast, even if the caster moves on", () => {
      const { skill, join, client, run, hits } = fakeRoom();
      const caster = join("caster", 400, 500);
      join("target", 400, 300);

      skill.cast(client("caster"), AHEAD);
      caster.y = 100;
      run(1000);
      assert.deepStrictEqual(hits.map((h) => h.sessionId), ["target"]);
    });

    it("strikes a target where the caster saw it, even if it has since stepped out of the fan", () => {
      const { skill, join, client, run, hits, applied, lag } = fakeRoom();
      join("caster", 400, 500);
      const target = join("target", 400, 300);
      // Live, the target has stepped well out to the side; on the caster's
      // screen, 150 ms behind, it still stands dead ahead.
      lag.past.set(target, { x: 400, y: 300, z: 0 });
      target.x = 700;
      lag.ms = 150;

      skill.cast(client("caster"), AHEAD);
      lag.ms = 0;
      run(1000);
      assert.deepStrictEqual(hits.map((h) => h.sessionId), ["target"]);
      assert.deepStrictEqual(applied.map((a) => [a.sessionId, a.id]), [["target", "stunned"]], "the stun lands live");
      assert.strictEqual(target.x, 700, "only the hit test is rewound");
      assert.ok(lag.asked.length > 0 && lag.asked.every((ms) => ms === 150), "the wave keeps its caster's lag for its whole run");
    });

    it("reads everyone live when the caster saw them live", () => {
      const { skill, join, client, run, hits, lag } = fakeRoom();
      join("caster", 400, 500);
      const target = join("target", 400, 300);
      lag.past.set(target, { x: 400, y: 300, z: 0 });
      target.x = 700;

      skill.cast(client("caster"), AHEAD);
      run(1000);
      assert.strictEqual(hits.length, 0, "where it is now, out of the fan");
      assert.ok(lag.asked.length > 0 && lag.asked.every((ms) => ms === 0));
    });

    it("a fresh round clears cooldowns and waves on their way; leaving clears only the cooldown", () => {
      const { skill, join, client, run, casts, hits } = fakeRoom();
      join("caster", 400, 500);
      join("target", 400, 300);

      skill.cast(client("caster"), AHEAD);
      skill.reset();
      run(1000);
      assert.strictEqual(hits.length, 0, "the wave vanished with the round");

      skill.cast(client("caster"), AHEAD);
      assert.strictEqual(casts().length, 2, "the cooldown went too");

      skill.remove("caster");
      skill.cast(client("caster"), AHEAD);
      assert.strictEqual(casts().length, 3, "leaving dropped the cooldown");
      run(1000);
      assert.deepStrictEqual(hits.map((h) => h.sessionId), ["target", "target"], "waves already on their way still run, each striking once");
    });
  });
});
