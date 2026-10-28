import assert from "assert";
import type { Client, Clock } from "colyseus";
import { LIVE, type SeenPoint } from "../src/skills/skillRoom.js";

import { MyRoomState, Player, Wall } from "../src/rooms/schema/MyRoomState.js";
import { MAX_HP, PLAYER_HALF, TICK_RATE } from "../src/shared/constants.js";
import type { DamageSource } from "../src/shared/combat.js";
import { SERVER_MESSAGE } from "../src/shared/messages.js";
import { moveLimits, type EffectId } from "../src/effects/effectConfig.js";
import { clearForcedMotion, stepEntity } from "../src/shared/movement.js";
import { LeapSkill } from "../src/skills/leap/leap.js";
import { LEAP, leapVelocity, type LeapCast, type LeapHit } from "../src/skills/leap/leapConfig.js";

/** One server tick, in seconds. */
const DT = 1 / TICK_RATE;
/** Not walking, not jumping, facing yaw 0 — the leap moves them, nothing else. */
const STILL = { moveX: 0, moveY: 0, yaw: 0, jump: false, breath: false } as const;
/** How far one leap carries its caster in the open. */
const DISTANCE = LEAP.speed * Math.ceil((LEAP.durationMs / 1000) * TICK_RATE) * DT;

/**
 * A room stand-in: real state, a clock the test moves by hand, the shared
 * movement step for everyone, and records of what the skill asked the room
 * to do (no Colyseus server is booted). `view.lag` is every caster's
 * `lagOf`; `view.then` is where `seenAgo` has players (by name) for any lag
 * above 0 — anyone not in it stands where they are now. `view.asked` records
 * every lag `seenAgo` was asked for.
 */
function fakeRoom() {
  const state = new MyRoomState();
  const view = { lag: 0, then: new Map<string, SeenPoint>(), asked: [] as number[] };
  const clock = { currentTime: 0 } as Clock;
  const hits: { sessionId: string; amount: number; source?: DamageSource }[] = [];
  const applied: { sessionId: string; id: EffectId; source?: DamageSource }[] = [];
  const sent: { type: string; message: unknown }[] = [];
  const room = {
    state,
    clock,
    broadcast(type: string, message: unknown) { sent.push({ type, message }); },
    send() {},
    damage(sessionId: string, amount: number, source?: DamageSource) {
      const player = state.players.get(sessionId);
      if (!player || player.hp <= 0) { return; }
      hits.push({ sessionId, amount, source });
      player.hp = Math.max(0, player.hp - amount);
      if (player.hp === 0) { clearForcedMotion(player); }
    },
    removeEffect() {},
    applyEffect(sessionId: string, id: EffectId, source?: DamageSource) {
      const player = state.players.get(sessionId);
      if (!player || player.hp <= 0) { return false; }
      applied.push({ sessionId, id, source });
      if (!player.effects.includes(id)) { player.effects.push(id); }
      return true;
    },
    addGroundZone() { return 0; },
    seenBy: () => LIVE,
    lagOf: () => view.lag,
    canAct: (sessionId: string) => (state.players.get(sessionId)?.hp ?? 0) > 0,
    seenAgo: (lagMs: number) => {
      view.asked.push(lagMs);
      return lagMs > 0 ? (player: Player) => view.then.get(player.name) ?? player : LIVE;
    },
  };
  const skill = new LeapSkill(room);
  const join = (sessionId: string, x: number, y: number, element = "wind") => {
    const player = new Player({ name: sessionId, hp: MAX_HP, element, x, y, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, dashVx: 0, dashVy: 0, dashTime: 0, flightZ: 0, breathing: false, ready: false, wins: 0, ownerId: "" });
    state.players.set(sessionId, player);
    return player;
  };
  const client = (sessionId: string) => ({ sessionId }) as Client;
  /** Runs `ms` worth of server ticks: everyone steps once, then the skill. */
  const run = (ms: number) => {
    for (let t = 0; t < ms; t += DT * 1000) {
      clock.currentTime += DT * 1000;
      for (const player of state.players.values()) {
        stepEntity(player, STILL, DT, moveLimits(player.effects), state.walls.values());
      }
      skill.step();
    }
  };
  const casts = () => sent.filter((m) => m.type === SERVER_MESSAGE.leapCast).map((m) => m.message as LeapCast);
  const contacts = () => sent.filter((m) => m.type === SERVER_MESSAGE.leapHit).map((m) => m.message as LeapHit);
  return { state, skill, join, client, run, casts, contacts, hits, applied, clock, view };
}

/** Facing straight ahead at yaw 0 is -y. */
const AHEAD = { yaw: 0 };

describe("leap", () => {
  it("slides level along the facing: at yaw 0 forward is -y, at -π/2 it is +x", () => {
    const ahead = leapVelocity(0);
    assert.ok(Math.abs(ahead.vx) < 1e-9 && Math.abs(ahead.vy + LEAP.speed) < 1e-9);
    const right = leapVelocity(-Math.PI / 2);
    assert.ok(Math.abs(right.vx - LEAP.speed) < 1e-9 && Math.abs(right.vy) < 1e-9);
    assert.ok(DISTANCE >= 150 && DISTANCE <= 220, `${DISTANCE} units`);
  });

  it("sets the dash along the sent facing and tells everyone", () => {
    const { skill, join, client, casts } = fakeRoom();
    const caster = join("caster", 400, 500);

    skill.cast(client("caster"), { yaw: -Math.PI / 2 });
    assert.ok(Math.abs(caster.dashVx - LEAP.speed) < 1e-9 && Math.abs(caster.dashVy) < 1e-9);
    assert.strictEqual(caster.dashTime, LEAP.durationMs / 1000);
    assert.deepStrictEqual(casts(), [{
      casterId: "caster", cooldownMs: LEAP.cooldownMs, x: 400, y: 500, yaw: -Math.PI / 2, durationMs: LEAP.durationMs,
    }]);
  });

  it("carries the caster its full distance along the ground, then stops", () => {
    const { skill, join, client, run } = fakeRoom();
    const caster = join("caster", 400, 500);

    skill.cast(client("caster"), AHEAD);
    run(1000);
    assert.ok(Math.abs(caster.y - (500 - DISTANCE)) < 1e-6, `ended at y ${caster.y}`);
    assert.strictEqual(caster.x, 400);
    assert.strictEqual(caster.z, 0, "never left the ground");
  });

  it("hurts each enemy it runs into 15, once, and spares the ones it passes by", () => {
    const { skill, join, client, run, hits, contacts } = fakeRoom();
    join("caster", 400, 500);
    join("first", 405, 450);
    join("second", 390, 380);
    join("aside", 460, 420);
    join("beyond", 400, 500 - DISTANCE - LEAP.contactDistance - 10);

    skill.cast(client("caster"), AHEAD);
    run(1000);
    assert.deepStrictEqual(hits.map((h) => [h.sessionId, h.amount, h.source?.ability, h.source?.id]), [
      ["first", LEAP.damage, "leap", "caster"], ["second", LEAP.damage, "leap", "caster"],
    ]);
    assert.deepStrictEqual(contacts(), [{ casterId: "caster", victimId: "first" }, { casterId: "caster", victimId: "second" }]);
  });

  it("runs into an enemy where the caster saw them, though they've since moved off the path", () => {
    const { state, skill, join, client, run, hits, contacts, view } = fakeRoom();
    const caster = join("caster", 400, 500);
    // On the caster's screen, 150 ms behind, they still stood in the way; they've stepped well aside since.
    join("dodger", 600, 420);
    view.lag = 150;
    view.then.set("dodger", { x: 400, y: 420, z: 0 });

    skill.cast(client("caster"), AHEAD);
    run(1000);
    assert.deepStrictEqual(hits.map((h) => [h.sessionId, h.amount, h.source?.ability]), [["dodger", LEAP.damage, "leap"]]);
    assert.deepStrictEqual(contacts(), [{ casterId: "caster", victimId: "dodger" }]);
    assert.ok(view.asked.length > 0 && view.asked.every((lag) => lag === 150), "every contact test read the world 150 ms ago");
    // Only where they stood was rewound: the caster slid live, the hurt landed on the live body.
    assert.ok(Math.abs(caster.y - (500 - DISTANCE)) < 1e-6, `ended at y ${caster.y}`);
    assert.strictEqual(state.players.get("dodger")!.hp, MAX_HP - LEAP.damage);
    assert.strictEqual(state.players.get("dodger")!.x, 600);
  });

  it("with no lag, enemies stand where they are now", () => {
    const { skill, join, client, run, hits, view } = fakeRoom();
    join("caster", 400, 500);
    join("dodger", 600, 420);
    join("stepped_in", 400, 420);
    // Ignored at lag 0: the leap reads everyone live.
    view.then.set("dodger", { x: 400, y: 420, z: 0 });
    view.then.set("stepped_in", { x: 600, y: 420, z: 0 });

    skill.cast(client("caster"), AHEAD);
    run(1000);
    assert.deepStrictEqual(hits.map((h) => h.sessionId), ["stepped_in"]);
    assert.ok(view.asked.length > 0 && view.asked.every((lag) => lag === 0));
  });

  it("doesn't tunnel through a body between two steps", () => {
    const { skill, join, client, run, hits } = fakeRoom();
    join("caster", 400, 500);
    // Two steps' positions straddle them: 20 units per step, they sit between.
    join("between", 400 + LEAP.contactDistance - 1, 490);

    skill.cast(client("caster"), AHEAD);
    run(1000);
    assert.deepStrictEqual(hits.map((h) => h.sessionId), ["between"]);
  });

  it("passes under a body high in the air, and never hurts the dead", () => {
    const { skill, join, client, run, hits } = fakeRoom();
    join("caster", 400, 500);
    join("corpse", 400, 450).hp = 0;
    const jumper = join("jumper", 400, 400);
    jumper.z = 60;
    jumper.flightZ = 60;

    skill.cast(client("caster"), AHEAD);
    run(1000);
    assert.strictEqual(hits.length, 0);
  });

  it("gives the caster Speed Boost once the leap ends, not before", () => {
    const { skill, join, client, run, applied } = fakeRoom();
    const caster = join("caster", 400, 500);

    skill.cast(client("caster"), AHEAD);
    run(100);
    assert.strictEqual(applied.length, 0, "still leaping");
    run(300);
    assert.strictEqual(caster.dashTime, 0);
    assert.deepStrictEqual(applied.map((a) => [a.sessionId, a.id, a.source?.ability]), [["caster", "speed_boost", "leap"]]);
    run(1000);
    assert.strictEqual(applied.length, 1, "once per leap");
  });

  it("stops at a wall and still ends with Speed Boost", () => {
    const { state, skill, join, client, run, applied } = fakeRoom();
    const caster = join("caster", 400, 500);
    // As thin as an Earth Wall.
    state.walls.set("wall", new Wall({ ownerId: "someone", kind: "wall", x: 400, y: 440, angle: 0, halfLength: 60, halfThickness: PLAYER_HALF * 0.7, height: 40 }));

    skill.cast(client("caster"), AHEAD);
    run(1000);
    assert.ok(caster.y > 440, `stopped short of the wall, at y ${caster.y}`);
    assert.deepStrictEqual(applied.map((a) => a.id), ["speed_boost"]);
  });

  it("refuses a second leap until the cooldown is over", () => {
    const { skill, join, client, casts, clock } = fakeRoom();
    join("caster", 400, 500);

    skill.cast(client("caster"), AHEAD);
    clock.currentTime = LEAP.cooldownMs - 1;
    skill.cast(client("caster"), AHEAD);
    assert.strictEqual(casts().length, 1);
    clock.currentTime = LEAP.cooldownMs;
    skill.cast(client("caster"), AHEAD);
    assert.strictEqual(casts().length, 2);
  });

  it("drops casts from other elements, the dead, strangers and junk", () => {
    const { skill, join, client, casts } = fakeRoom();
    const earth = join("earth", 400, 500, "earth");
    join("dead", 400, 500).hp = 0;
    const caster = join("caster", 400, 500);

    skill.cast(client("earth"), AHEAD);
    skill.cast(client("dead"), AHEAD);
    skill.cast(client("nobody"), AHEAD);
    for (const junk of [undefined, null, 5, "x", {}, { yaw: "0" }, { yaw: NaN }, { yaw: Infinity }]) {
      skill.cast(client("caster"), junk);
    }
    assert.strictEqual(casts().length, 0);
    assert.strictEqual(earth.dashTime, 0);
    assert.strictEqual(caster.dashTime, 0);
  });

  it("a caster who dies mid-leap stops hitting and gets no boost", () => {
    const { state, skill, join, client, run, hits, applied } = fakeRoom();
    const caster = join("caster", 400, 500);
    join("target", 400, 380);

    skill.cast(client("caster"), AHEAD);
    run(40);
    // The room's damage clears a dead body's slide.
    caster.hp = 0;
    clearForcedMotion(caster);
    run(1000);
    assert.strictEqual(hits.length, 0);
    assert.strictEqual(applied.length, 0);

    // Back to life where the target stands: the old leap is gone for good.
    caster.hp = MAX_HP;
    caster.y = 380;
    run(100);
    assert.strictEqual(hits.length, 0);
    assert.ok(state.players.get("target")!.hp === MAX_HP);
  });

  it("a fresh round clears cooldowns and leaps; leaving clears both too", () => {
    const { skill, join, client, run, casts, hits, applied } = fakeRoom();
    const caster = join("caster", 400, 500);
    join("target", 400, 400);

    skill.cast(client("caster"), AHEAD);
    skill.reset();
    clearForcedMotion(caster);
    run(1000);
    assert.strictEqual(hits.length, 0, "the leap vanished with the round");
    assert.strictEqual(applied.length, 0);

    skill.cast(client("caster"), AHEAD);
    assert.strictEqual(casts().length, 2, "the cooldown went too");
    skill.remove("caster");
    skill.cast(client("caster"), AHEAD);
    assert.strictEqual(casts().length, 3, "leaving dropped the cooldown");
  });
});
