import assert from "assert";
import type { Client, Clock } from "colyseus";
import { LIVE } from "../src/skills/skillRoom.js";

import { MyRoomState, Player } from "../src/rooms/schema/MyRoomState.js";
import { MAX_HP, TICK_RATE } from "../src/shared/constants.js";
import type { DamageSource } from "../src/shared/combat.js";
import { SERVER_MESSAGE } from "../src/shared/messages.js";
import { moveLimits, type EffectId } from "../src/effects/effectConfig.js";
import { stepEntity } from "../src/shared/movement.js";
import { PuffSkill } from "../src/skills/puff/puff.js";
import { PUFF, PUFF_REACH, type PuffCast } from "../src/skills/puff/puffConfig.js";

const DT = 1 / TICK_RATE;
const still = { moveX: 0, moveY: 0, yaw: 0, jump: false, breath: false } as const;

/**
 * A room stand-in: real state, a clock the test moves by hand, and records of
 * what the skill asked the room to do (no Colyseus server is booted).
 */
function fakeRoom() {
  const state = new MyRoomState();
  const clock = { currentTime: 0 } as Clock;
  const hits: { sessionId: string; amount: number; source?: DamageSource }[] = [];
  const applied: { sessionId: string; id: EffectId; source?: DamageSource; durationMs?: number }[] = [];
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
    lagOf: () => 0,
    seenAgo: () => LIVE,
  };
  const skill = new PuffSkill(room);
  const join = (sessionId: string, x: number, y: number, element = "wind") => {
    const player = new Player({ name: sessionId, hp: MAX_HP, element, x, y, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, dashVx: 0, dashVy: 0, dashTime: 0, flightZ: 0, breathing: false, ready: false, wins: 0, ownerId: "" });
    state.players.set(sessionId, player);
    return player;
  };
  const client = (sessionId: string) => ({ sessionId }) as Client;
  const casts = () => sent.filter((m) => m.type === SERVER_MESSAGE.puffCast).map((m) => m.message as PuffCast);
  return { state, skill, join, client, casts, hits, applied, clock };
}

describe("puff", () => {
  it("hurts and blows away every enemy in reach, straight away from the caster", () => {
    const { skill, join, client, casts, hits } = fakeRoom();
    join("caster", 400, 300);
    const east = join("east", 460, 300, "fire");
    const north = join("north", 400, 300 - PUFF_REACH + 1, "water");
    const diagonal = join("diagonal", 350, 350, "earth");

    skill.cast(client("caster"));
    assert.deepStrictEqual(hits.map((h) => [h.sessionId, h.amount, h.source?.ability, h.source?.id]), [
      ["east", PUFF.damage, "puff", "caster"], ["north", PUFF.damage, "puff", "caster"], ["diagonal", PUFF.damage, "puff", "caster"],
    ]);
    assert.strictEqual(east.hp, MAX_HP - PUFF.damage);

    const time = PUFF.pushMs / 1000;
    assert.deepStrictEqual([east.dashVx, east.dashVy, east.dashTime], [PUFF.pushSpeed, 0, time], "east goes +x");
    assert.deepStrictEqual([north.dashVx, north.dashVy], [0, -PUFF.pushSpeed], "north goes -y");
    assert.ok(Math.abs(diagonal.dashVx + PUFF.pushSpeed * Math.SQRT1_2) < 1e-9 && Math.abs(diagonal.dashVy - PUFF.pushSpeed * Math.SQRT1_2) < 1e-9, "diagonal goes -x +y");
    assert.strictEqual(east.vz, PUFF.popSpeed, "a little hop");

    const [cast] = casts();
    assert.deepStrictEqual(cast.hits.map((h) => h.id), ["east", "north", "diagonal"]);
    assert.deepStrictEqual({ ...cast, hits: [] }, { casterId: "caster", cooldownMs: PUFF.cooldownMs, x: 400, y: 300, z: 0, hits: [] });
  });

  it("pushes a victim a good way off through the shared movement step", () => {
    const { skill, join, client } = fakeRoom();
    join("caster", 400, 300);
    const victim = join("victim", 440, 300, "fire");

    skill.cast(client("caster"));
    // Walking back towards the caster (-x at yaw 0) all the while.
    for (let i = 0; i < TICK_RATE && victim.dashTime > 0; i++) { stepEntity(victim, { ...still, moveX: -1 }, DT, moveLimits([])); }
    const pushed = victim.x - 440;
    assert.ok(pushed >= 80 && pushed <= 140, `blown ${pushed} units away`);
    assert.ok(Math.abs(pushed - PUFF.pushSpeed * PUFF.pushMs / 1000) <= PUFF.pushSpeed * DT, "at the push speed, for the push time");
  });

  it("spares whoever is out of reach, high above, dead, or the caster", () => {
    const { skill, join, client, hits, state } = fakeRoom();
    const caster = join("caster", 400, 300);
    join("far", 400 + PUFF_REACH + 1, 300, "fire");
    join("high", 420, 300, "fire").z = PUFF.heightReach + 1;
    join("dead", 420, 300, "fire").hp = 0;

    skill.cast(client("caster"));
    assert.deepStrictEqual(hits, []);
    for (const [, player] of state.players) { assert.strictEqual(player.dashTime, 0); }
    assert.strictEqual(caster.hp, MAX_HP);
  });

  it("boosts the caster on every cast, hit or miss", () => {
    const { skill, join, client, applied, clock } = fakeRoom();
    const caster = join("caster", 400, 300);

    skill.cast(client("caster"));
    assert.deepStrictEqual(applied.map((a) => [a.sessionId, a.id, a.source?.ability]), [["caster", "speed_boost", "puff"]]);
    assert.deepStrictEqual([...caster.effects], ["speed_boost"]);

    join("victim", 430, 300, "fire");
    clock.currentTime = PUFF.cooldownMs;
    skill.cast(client("caster"));
    assert.deepStrictEqual(applied.map((a) => a.id), ["speed_boost", "speed_boost"], "renewed");
  });

  it("doesn't push a victim it kills", () => {
    const { skill, join, client, casts } = fakeRoom();
    join("caster", 400, 300);
    const victim = join("victim", 430, 300, "fire");
    victim.hp = PUFF.damage;

    skill.cast(client("caster"));
    assert.strictEqual(victim.hp, 0);
    assert.strictEqual(victim.dashTime, 0);
    assert.deepStrictEqual(casts()[0].hits, []);
  });

  it("blows a victim standing right on the caster along the caster's facing", () => {
    const { skill, join, client } = fakeRoom();
    join("caster", 400, 300).yaw = -Math.PI / 2;
    const victim = join("victim", 400, 300, "fire");

    skill.cast(client("caster"));
    assert.ok(Math.abs(victim.dashVx - PUFF.pushSpeed) < 1e-9 && Math.abs(victim.dashVy) < 1e-9, "forward at yaw -π/2 is +x");
  });

  it("refuses a second cast until the cooldown is over", () => {
    const { skill, join, client, casts, clock } = fakeRoom();
    join("caster", 400, 300);

    skill.cast(client("caster"));
    clock.currentTime = PUFF.cooldownMs - 1;
    skill.cast(client("caster"));
    assert.strictEqual(casts().length, 1);
    clock.currentTime = PUFF.cooldownMs;
    skill.cast(client("caster"));
    assert.strictEqual(casts().length, 2);
  });

  it("drops casts from other elements, the dead and strangers", () => {
    const { skill, join, client, casts, applied } = fakeRoom();
    join("fire", 400, 300, "fire");
    join("dead", 400, 300).hp = 0;
    join("victim", 420, 300, "earth");

    skill.cast(client("fire"));
    skill.cast(client("dead"));
    skill.cast(client("nobody"));
    assert.strictEqual(casts().length, 0);
    assert.strictEqual(applied.length, 0);
  });

  it("a fresh round or leaving drops the cooldown", () => {
    const { skill, join, client, casts } = fakeRoom();
    join("caster", 400, 300);

    skill.cast(client("caster"));
    skill.reset();
    skill.cast(client("caster"));
    skill.remove("caster");
    skill.cast(client("caster"));
    assert.strictEqual(casts().length, 3);
  });
});
