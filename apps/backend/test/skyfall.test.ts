import assert from "assert";
import type { Client, Clock } from "colyseus";

import { MyRoomState, Player } from "../src/rooms/schema/MyRoomState.js";
import { ARENA_WIDTH, MAX_HP, PLAYER_HALF, TICK_RATE } from "../src/shared/constants.js";
import { SERVER_MESSAGE } from "../src/shared/messages.js";
import type { DamageSource } from "../src/shared/combat.js";
import { moveLimits, type EffectId } from "../src/effects/effectConfig.js";
import { clearForcedMotion, stepEntity, type MoveInputLike } from "../src/shared/movement.js";
import { LIVE, type SeenPoint, type SkillRoom } from "../src/skills/skillRoom.js";
import { SkyfallSkill } from "../src/skills/skyfall/skyfall.js";
import {
  SKYFALL, clampSkyfallTarget, fallSteps, leapToward, soarHeight,
  type SkyfallDrop, type SkyfallLand, type SkyfallRise,
} from "../src/skills/skyfall/skyfallConfig.js";

/** One server tick, in seconds. */
const DT = 1 / TICK_RATE;
const STILL: MoveInputLike = { moveX: 0, moveY: 0, yaw: 0, jump: false, breath: false };

/**
 * A room stand-in: real state, a clock the test moves by hand, and records of
 * what the skill asked the room to do (no Colyseus server is booted). Each
 * tick steps every player like the room does — the shared movement step under
 * their effects — and then the skill.
 */
function fakeRoom() {
  const state = new MyRoomState();
  const clock = { currentTime: 0 } as Clock;
  const hits: { sessionId: string; amount: number; source?: DamageSource }[] = [];
  const applied: { sessionId: string; id: EffectId; durationMs?: number }[] = [];
  const sent: { type: string; message: unknown }[] = [];
  /** Lag compensation: each player's `lagOf`, and where a player stood on a lagging screen (live if unset). */
  const lags = new Map<string, number>();
  const past = new Map<Player, SeenPoint>();
  /** Every `seenAgo` the skill asked for, in ms. */
  const rewinds: number[] = [];
  const room: SkillRoom = {
    state,
    clock,
    broadcast(type, message) { sent.push({ type, message }); },
    send() {},
    damage(sessionId, amount, source) {
      const player = state.players.get(sessionId);
      if (!player || player.hp <= 0) { return; }
      hits.push({ sessionId, amount, source });
      player.hp = Math.max(0, player.hp - amount);
    },
    removeEffect(sessionId, id) {
      const player = state.players.get(sessionId);
      const at = player?.effects.indexOf(id) ?? -1;
      if (player && at >= 0) { player.effects.splice(at, 1); }
    },
    applyEffect(sessionId, id, _source, durationMs) {
      const player = state.players.get(sessionId);
      if (!player || player.hp <= 0) { return false; }
      applied.push({ sessionId, id, durationMs });
      if (!player.effects.includes(id)) { player.effects.push(id); }
      return true;
    },
    addGroundZone: () => 0,
    seenBy: () => LIVE,
    lagOf: (sessionId) => lags.get(sessionId) ?? 0,
    canAct: (sessionId: string) => (state.players.get(sessionId)?.hp ?? 0) > 0,
    seenAgo(lagMs) {
      rewinds.push(lagMs);
      return lagMs > 0 ? (player) => past.get(player) ?? player : LIVE;
    },
  };
  const skill = new SkyfallSkill(room);
  const join = (sessionId: string, x: number, y: number, element = "wind") => {
    const player = new Player({ name: sessionId, hp: MAX_HP, element, x, y, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, dashVx: 0, dashVy: 0, dashTime: 0, flightZ: 0, breathing: false, ready: false, wins: 0, ownerId: "" });
    state.players.set(sessionId, player);
    return player;
  };
  const client = (sessionId: string) => ({ sessionId }) as Client;
  /** What each player presses, by session id; still by default. */
  const inputs = new Map<string, MoveInputLike>();
  /** Runs `ms` worth of server ticks. */
  const run = (ms: number) => {
    for (let t = 0; t < ms; t += DT * 1000) {
      clock.currentTime += DT * 1000;
      for (const [sessionId, player] of state.players) {
        stepEntity(player, inputs.get(sessionId) ?? STILL, DT, moveLimits(player.effects));
        skill.afterInput(sessionId, player);
      }
      skill.step();
    }
  };
  const messages = <T>(type: string) => sent.filter((m) => m.type === type).map((m) => m.message as T);
  return { state, skill, join, client, run, inputs, clock, hits, applied, messages, lags, past, rewinds };
}

describe("skyfall", () => {
  describe("shared rules", () => {
    it("soars very high, far above any jump", () => {
      assert.strictEqual(soarHeight({ x: 400, y: 300 }), SKYFALL.height);
      assert.ok(SKYFALL.height >= 350 && SKYFALL.height <= 500);
    });

    it("pulls a drop into range from the point below, and into the arena", () => {
      assert.deepStrictEqual(clampSkyfallTarget({ x: 400, y: 300 }, { x: 450, y: 260 }), { x: 450, y: 260 });
      const far = clampSkyfallTarget({ x: 100, y: 300 }, { x: 700, y: 300 });
      assert.ok(Math.abs(far.x - (100 + SKYFALL.dropRange)) < 1e-9 && far.y === 300);
      assert.deepStrictEqual(clampSkyfallTarget({ x: ARENA_WIDTH - 20, y: 20 }, { x: ARENA_WIDTH + 50, y: -50 }), { x: ARENA_WIDTH - PLAYER_HALF, y: PLAYER_HALF });
    });

    it("lands a leap on its target from any height, on the step the slide ends", () => {
      for (const z of [0, 30, 150, SKYFALL.height]) {
        const body = { x: 200, y: 300, z, vx: 0, vy: 0, vz: 0, yaw: 0, dashVx: 0, dashVy: 0, dashTime: 0, flightZ: 0 };
        Object.assign(body, leapToward(body, { x: 420, y: 180 }, -SKYFALL.dropSpeed));
        const steps = fallSteps(z, -SKYFALL.dropSpeed);
        for (let i = 0; i < steps; i++) { stepEntity(body, STILL, DT, moveLimits([])); }
        assert.strictEqual(body.z, 0, `down from ${z}`);
        assert.strictEqual(body.dashTime, 0);
        assert.ok(Math.hypot(body.x - 420, body.y - 180) < 1e-6, `on target from ${z}`);
      }
    });
  });

  describe("server skill", () => {
    it("launches a wind mage skyward, soaring, and tells everyone", () => {
      const { skill, join, client, run, applied, messages } = fakeRoom();
      const caster = join("caster", 400, 300);

      skill.cast(client("caster"), undefined);
      assert.strictEqual(caster.flightZ, SKYFALL.height);
      assert.deepStrictEqual(applied.map((a) => [a.sessionId, a.id]), [["caster", "soaring"]]);
      assert.deepStrictEqual(messages<SkyfallRise>(SERVER_MESSAGE.skyfallRise), [{
        casterId: "caster", x: 400, y: 300, height: SKYFALL.height, soarMs: SKYFALL.soarMs, cooldownMs: SKYFALL.cooldownMs,
      }]);

      run(1000);
      assert.strictEqual(caster.z, SKYFALL.height, "hovering at the top");
    });

    it("walks at half speed up there", () => {
      const { skill, join, client, run, inputs } = fakeRoom();
      const caster = join("caster", 400, 500);
      skill.cast(client("caster"), undefined);
      run(1000);
      inputs.set("caster", { ...STILL, moveY: -1 });
      run(DT * 1000 * 3);
      assert.ok(Math.abs((500 - caster.y) - 3 * 260 * 0.5 * DT) < 1e-6);
    });

    it("drops onto the chosen point and hurts enemies near it, not further out", () => {
      const { skill, join, client, run, hits, applied, messages, state } = fakeRoom();
      const caster = join("caster", 300, 300);
      join("near", 520, 260);
      join("edge", 500 + SKYFALL.radius + PLAYER_HALF - 2, 250);
      join("outside", 500 + SKYFALL.radius + PLAYER_HALF + 3, 250);
      join("flying", 500, 250).flightZ = 200;

      skill.cast(client("caster"), undefined);
      run(800);
      skill.drop(client("caster"), { x: 500, y: 250 });
      run(100);
      const [drop] = messages<SkyfallDrop>(SERVER_MESSAGE.skyfallDrop);
      assert.deepStrictEqual([drop.x, drop.y, drop.casterId], [500, 250, "caster"]);
      assert.strictEqual(caster.flightZ, 0);
      assert.deepStrictEqual(hits, [], "not down yet");

      run(1500);
      assert.strictEqual(caster.z, 0);
      assert.ok(Math.hypot(caster.x - 500, caster.y - 250) < 3, "landed on the point");
      assert.deepStrictEqual(hits.map((h) => [h.sessionId, h.amount, h.source?.ability, h.source?.id]), [
        ["near", SKYFALL.damage, "skyfall", "caster"], ["edge", SKYFALL.damage, "skyfall", "caster"],
      ]);
      assert.strictEqual(state.players.get("outside")!.hp, MAX_HP);
      assert.strictEqual(state.players.get("flying")!.hp, MAX_HP, "far up in the air");
      const [land] = messages<SkyfallLand>(SERVER_MESSAGE.skyfallLand);
      assert.deepStrictEqual(land.hits, ["near", "edge"]);

      assert.deepStrictEqual(applied.filter((a) => a.sessionId === "caster").map((a) => a.id), ["soaring", "speed_boost"]);
      assert.deepStrictEqual([...caster.effects], ["speed_boost"], "no longer soaring");
    });

    it("pulls a far drop into range", () => {
      const { skill, join, client, run } = fakeRoom();
      const caster = join("caster", 100, 300);
      skill.cast(client("caster"), undefined);
      run(800);
      skill.drop(client("caster"), { x: 790, y: 300 });
      run(1500);
      assert.ok(Math.abs(caster.x - (100 + SKYFALL.dropRange)) < 3 && Math.abs(caster.y - 300) < 1e-6);
    });

    it("keeps a drop chosen while still rising until it is all the way up", () => {
      const { skill, join, client, run, messages } = fakeRoom();
      const caster = join("caster", 300, 300);
      skill.cast(client("caster"), undefined);
      run(DT * 1000 * 2);
      skill.drop(client("caster"), { x: 350, y: 300 });
      run(DT * 1000);
      assert.strictEqual(messages(SERVER_MESSAGE.skyfallDrop).length, 0);
      run(600);
      const [drop] = messages<SkyfallDrop>(SERVER_MESSAGE.skyfallDrop);
      assert.strictEqual(drop.fromZ, SKYFALL.height);
      run(1500);
      assert.ok(Math.abs(caster.x - 350) < 3);
    });

    it("drops straight down on its own once the soar runs out", () => {
      const { skill, join, client, run, hits, messages } = fakeRoom();
      const caster = join("caster", 300, 300);
      join("below", 320, 300);

      skill.cast(client("caster"), undefined);
      run(SKYFALL.soarMs - 100);
      assert.strictEqual(caster.z, SKYFALL.height, "still up");
      run(200);
      assert.strictEqual(messages(SERVER_MESSAGE.skyfallDrop).length, 1);
      run(1500);
      assert.deepStrictEqual([caster.x, caster.y, caster.z], [300, 300, 0]);
      assert.deepStrictEqual(hits.map((h) => h.sessionId), ["below"]);
    });

    it("ignores junk drops, drops when not soaring, and a second choice", () => {
      const { skill, join, client, run, messages } = fakeRoom();
      const caster = join("caster", 300, 300);
      skill.drop(client("caster"), { x: 350, y: 300 });
      skill.cast(client("caster"), undefined);
      run(800);
      for (const junk of [undefined, null, 5, "x", {}, { x: "1", y: 2 }, { x: NaN, y: 0 }, { x: 0, y: Infinity }]) {
        skill.drop(client("caster"), junk);
      }
      run(100);
      assert.strictEqual(messages(SERVER_MESSAGE.skyfallDrop).length, 0);
      skill.drop(client("caster"), { x: 250, y: 300 });
      skill.drop(client("caster"), { x: 600, y: 300 });
      run(1500);
      assert.ok(Math.abs(caster.x - 250) < 3);
      assert.strictEqual(messages(SERVER_MESSAGE.skyfallDrop).length, 1);
    });

    it("drops casts from other elements, the dead, strangers, and while already up", () => {
      const { skill, join, client, messages } = fakeRoom();
      join("fire", 300, 300, "fire");
      join("dead", 300, 300).hp = 0;
      join("caster", 300, 300);

      skill.cast(client("fire"), undefined);
      skill.cast(client("dead"), undefined);
      skill.cast(client("nobody"), undefined);
      assert.strictEqual(messages(SERVER_MESSAGE.skyfallRise).length, 0);
      skill.cast(client("caster"), undefined);
      skill.cast(client("caster"), undefined);
      assert.strictEqual(messages(SERVER_MESSAGE.skyfallRise).length, 1);
    });

    it("refuses a second cast until the cooldown is over", () => {
      const { skill, join, client, run, clock, messages } = fakeRoom();
      join("caster", 300, 300);

      skill.cast(client("caster"), undefined);
      run(5000);
      clock.currentTime = SKYFALL.cooldownMs - 1;
      skill.cast(client("caster"), undefined);
      assert.strictEqual(messages(SERVER_MESSAGE.skyfallRise).length, 1);
      clock.currentTime = SKYFALL.cooldownMs;
      skill.cast(client("caster"), undefined);
      assert.strictEqual(messages(SERVER_MESSAGE.skyfallRise).length, 2);
    });

    it("hurts an enemy where the caster saw them at the drop, though they have since moved away", () => {
      const { skill, join, client, run, hits, messages, lags, past, rewinds } = fakeRoom();
      join("caster", 300, 300);
      const runner = join("runner", 500 + SKYFALL.radius + PLAYER_HALF + 40, 250);
      const ghost = join("ghost", 520, 260);
      past.set(runner, { x: 510, y: 250, z: 0 });
      past.set(ghost, { x: 500 + SKYFALL.radius + PLAYER_HALF + 40, y: 250, z: 0 });

      lags.set("caster", 60);
      skill.cast(client("caster"), undefined);
      run(800);
      lags.set("caster", 150);
      skill.drop(client("caster"), { x: 500, y: 250 });
      lags.set("caster", 0);
      run(1500);
      assert.deepStrictEqual(rewinds, [150], "the lag as of the drop, kept to the touchdown");
      assert.deepStrictEqual(hits.map((h) => h.sessionId), ["runner"]);
      assert.deepStrictEqual(messages<SkyfallLand>(SERVER_MESSAGE.skyfallLand)[0].hits, ["runner"]);
      assert.deepStrictEqual([runner.x, runner.y], [500 + SKYFALL.radius + PLAYER_HALF + 40, 250], "only the read is rewound, not the body");
    });

    it("with no lag, hurts enemies where they are now", () => {
      const { skill, join, client, run, hits, past, rewinds } = fakeRoom();
      join("caster", 300, 300);
      const runner = join("runner", 500 + SKYFALL.radius + PLAYER_HALF + 40, 250);
      const near = join("near", 520, 260);
      past.set(runner, { x: 510, y: 250, z: 0 });
      past.set(near, { x: 500 + SKYFALL.radius + PLAYER_HALF + 40, y: 250, z: 0 });

      skill.cast(client("caster"), undefined);
      run(800);
      skill.drop(client("caster"), { x: 500, y: 250 });
      run(1500);
      assert.deepStrictEqual(rewinds, [0]);
      assert.deepStrictEqual(hits.map((h) => h.sessionId), ["near"]);
    });

    it("a caster who dies on the way down hurts no one where they fall", () => {
      const { skill, join, client, run, hits, applied, messages } = fakeRoom();
      const caster = join("caster", 300, 300);
      join("below", 300, 300);

      skill.cast(client("caster"), undefined);
      run(800);
      skill.drop(client("caster"), { x: 300, y: 300 });
      run(200);
      // What the room does on a killing blow.
      caster.hp = 0;
      clearForcedMotion(caster);
      run(2000);
      assert.strictEqual(caster.z, 0, "fell");
      assert.deepStrictEqual(hits, []);
      assert.strictEqual(messages(SERVER_MESSAGE.skyfallLand).length, 0);
      assert.ok(!applied.some((a) => a.id === "speed_boost"));
    });

    it("a fresh round, or leaving, drops the flight and the cooldown", () => {
      const { skill, join, client, run, hits, messages } = fakeRoom();
      const caster = join("caster", 300, 300);
      join("below", 300, 300);

      skill.cast(client("caster"), undefined);
      run(800);
      skill.reset();
      clearForcedMotion(caster);
      run(SKYFALL.soarMs);
      assert.deepStrictEqual(hits, [], "no landing");
      skill.cast(client("caster"), undefined);
      assert.strictEqual(messages(SERVER_MESSAGE.skyfallRise).length, 2);

      skill.remove("caster");
      run(SKYFALL.soarMs + 2000);
      assert.strictEqual(messages(SERVER_MESSAGE.skyfallDrop).length, 0);
      skill.cast(client("caster"), undefined);
      assert.strictEqual(messages(SERVER_MESSAGE.skyfallRise).length, 3);
    });
  });
});
