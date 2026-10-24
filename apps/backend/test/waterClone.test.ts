import assert from "assert";
import type { Client, Clock } from "colyseus";
import { LIVE } from "../src/skills/skillRoom.js";

import { MyRoomState, Player, Wall } from "../src/rooms/schema/MyRoomState.js";
import { MAX_HP, PLAYER_SPEED, TICK_RATE } from "../src/shared/constants.js";
import type { DamageSource } from "../src/shared/combat.js";
import { SERVER_MESSAGE } from "../src/shared/messages.js";
import { EFFECTS, isUntargetable, type EffectId } from "../src/effects/effectConfig.js";
import type { WaterWhipAim } from "../src/skills/waterWhip/waterWhipConfig.js";
import { WaterCloneSkill } from "../src/skills/waterClone/waterClone.js";
import {
  WATER_CLONE, isWaterClone, sparedAsOwnClone, type WaterCloneCast, type WaterCloneEnd,
} from "../src/skills/waterClone/waterCloneConfig.js";

/** One server tick, in seconds. */
const DT = 1 / TICK_RATE;
/** Looking straight ahead at yaw 0: along -y, level. */
const AHEAD = { yaw: 0, pitch: 0 };

/**
 * A room stand-in: real state, a clock the test moves by hand, a whip that
 * only records what it was asked to lash, and records of what the skill
 * asked the room to do (no Colyseus server is booted).
 */
function fakeRoom() {
  const state = new MyRoomState();
  const clock = { currentTime: 0 } as Clock;
  const sent: { type: string; message: unknown }[] = [];
  const room = {
    state,
    clock,
    broadcast(type: string, message: unknown) { sent.push({ type, message }); },
    send() {},
    damage(sessionId: string, amount: number, source?: DamageSource) {
      const player = state.players.get(sessionId);
      if (!player || player.hp <= 0 || isUntargetable(player.effects) || sparedAsOwnClone(player, source?.id)) { return; }
      player.hp = Math.max(0, player.hp - amount);
    },
    removeEffect() {},
    applyEffect() { return false; },
    addGroundZone() { return 0; },
    seenBy: () => LIVE,
    lagOf: () => 0,
    seenAgo: () => LIVE,
  };
  const attacks: { attackerId: string; at: { x: number; y: number; z: number }; aim: WaterWhipAim; source: DamageSource; ignore?: ReadonlySet<string>; damage?: number }[] = [];
  const whipRemoved: string[] = [];
  const whip = {
    attack(attackerId: string, at: { x: number; y: number; z: number }, aim: WaterWhipAim, source: DamageSource, ignore?: ReadonlySet<string>, damage?: number) {
      attacks.push({ attackerId, at: { x: at.x, y: at.y, z: at.z }, aim, source, ignore, damage });
      return true;
    },
    remove(id: string) { whipRemoved.push(id); },
  };
  const gone: string[] = [];
  const skill = new WaterCloneSkill(room, whip, undefined, (id) => gone.push(id));
  const join = (sessionId: string, x: number, y: number, element = "water") => {
    const player = new Player({ name: sessionId, hp: MAX_HP, element, x, y, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, dashVx: 0, dashVy: 0, dashTime: 0, flightZ: 0, breathing: false, ready: false, wins: 0, ownerId: "" });
    state.players.set(sessionId, player);
    return player;
  };
  const client = (sessionId: string) => ({ sessionId }) as Client;
  const casts = () => sent.filter((m) => m.type === SERVER_MESSAGE.waterCloneCast).map((m) => m.message as WaterCloneCast);
  const ends = () => sent.filter((m) => m.type === SERVER_MESSAGE.waterCloneEnd).map((m) => m.message as WaterCloneEnd);
  /** The clone `ownerId` has out, if any. */
  const cloneOf = (ownerId: string) => [...state.players].find(([, p]) => p.ownerId === ownerId);
  const steps = (n: number) => { for (let i = 0; i < n; i++) { skill.step(DT); } };
  return { state, clock, skill, join, client, casts, ends, cloneOf, steps, attacks, whipRemoved, gone, damage: room.damage };
}

describe("water clone", () => {
  it("spawns just ahead of the caster with its own health, after the enemy under the aim over the nearest", () => {
    const { skill, join, client, casts, cloneOf } = fakeRoom();
    join("caster", 400, 300);
    join("near", 340, 300, "fire");
    join("aimed", 400, 50, "earth");

    skill.cast(client("caster"), AHEAD);
    const [cast] = casts();
    assert.strictEqual(cast.targetId, "aimed");
    const [id, clone] = cloneOf("caster")!;
    assert.strictEqual(cast.cloneId, id);
    assert.ok(isWaterClone(clone));
    assert.deepStrictEqual([clone.hp, clone.element, clone.name], [WATER_CLONE.hp, "water", "caster"]);
    assert.ok(Math.abs(clone.x - 400) < 1e-9 && Math.abs(clone.y - (300 - WATER_CLONE.spawnDistance)) < 1e-9, "ahead along -y");
  });

  it("goes after the nearest enemy when none is under the aim, skipping the untargetable and the shielded", () => {
    const { state, skill, join, client, casts } = fakeRoom();
    join("caster", 400, 300);
    join("far", 590, 300, "fire");
    join("under", 380, 300, "earth").effects.push("burrowed");
    join("behindWall", 400, 60, "fire");
    // A wall across the aimed line: whoever is behind it isn't "under the aim".
    state.walls.set("w", new Wall({ ownerId: "x", kind: "wall", x: 400, y: 200, angle: 0, halfLength: 40, halfThickness: 5, height: 60 }));

    skill.cast(client("caster"), AHEAD);
    assert.strictEqual(casts()[0].targetId, "far");
  });

  it("with no enemy at all still spawns and idles, then goes after the first to show up", () => {
    const { skill, join, client, casts, cloneOf, steps, attacks } = fakeRoom();
    join("caster", 400, 300);

    skill.cast(client("caster"), AHEAD);
    assert.strictEqual(casts()[0].targetId, "");
    const [, clone] = cloneOf("caster")!;
    const before = { x: clone.x, y: clone.y };
    steps(10);
    assert.deepStrictEqual({ x: clone.x, y: clone.y }, before);
    assert.strictEqual(attacks.length, 0);

    join("late", 400 + WATER_CLONE.stopRange * 0.5, before.y, "fire");
    steps(1);
    assert.strictEqual(attacks.length, 1, "lashes the newcomer");
  });

  it("allows one clone at a time, and drops casts from other elements, the dead and strangers", () => {
    const { skill, join, client, casts } = fakeRoom();
    join("caster", 400, 300);
    join("fire", 200, 300, "fire");
    join("dead", 200, 200).hp = 0;

    skill.cast(client("caster"), AHEAD);
    skill.cast(client("caster"), AHEAD);
    skill.cast(client("fire"), AHEAD);
    skill.cast(client("dead"), AHEAD);
    skill.cast(client("nobody"), AHEAD);
    skill.cast(client("caster"), { yaw: "x" });
    assert.strictEqual(casts().length, 1);
  });

  it("starts the cooldown only once the clone is killed", () => {
    const { state, clock, skill, join, client, casts, ends, cloneOf, steps } = fakeRoom();
    join("caster", 400, 300);
    join("enemy", 400, 100, "fire");

    skill.cast(client("caster"), AHEAD);
    const killedAt = WATER_CLONE.lifetimeMs - 1;
    clock.currentTime = killedAt;
    steps(1);
    assert.strictEqual(ends().length, 0, "not cooling down while it is out");

    const [id, clone] = cloneOf("caster")!;
    clone.hp = 0;
    steps(1);
    assert.deepStrictEqual(ends(), [{ casterId: "caster", cloneId: id, reason: "killed", cooldownMs: WATER_CLONE.cooldownMs, x: clone.x, y: clone.y, z: clone.z }]);
    assert.ok(!state.players.has(id), "its body leaves the state");

    clock.currentTime = killedAt + WATER_CLONE.cooldownMs - 1;
    skill.cast(client("caster"), AHEAD);
    assert.strictEqual(casts().length, 1);
    clock.currentTime = killedAt + WATER_CLONE.cooldownMs;
    skill.cast(client("caster"), AHEAD);
    assert.strictEqual(casts().length, 2);
  });

  it("melts away once its time is up, and the cooldown starts then", () => {
    const { state, clock, skill, join, client, casts, ends, cloneOf, steps } = fakeRoom();
    join("caster", 400, 300);
    join("enemy", 400, 100, "fire");

    skill.cast(client("caster"), AHEAD);
    const [id, clone] = cloneOf("caster")!;
    clock.currentTime = WATER_CLONE.lifetimeMs - 1;
    steps(1);
    assert.strictEqual(ends().length, 0);

    clock.currentTime = WATER_CLONE.lifetimeMs;
    steps(1);
    assert.deepStrictEqual(ends(), [{ casterId: "caster", cloneId: id, reason: "expired", cooldownMs: WATER_CLONE.cooldownMs, x: clone.x, y: clone.y, z: clone.z }]);
    assert.ok(!state.players.has(id));

    clock.currentTime = WATER_CLONE.lifetimeMs + WATER_CLONE.cooldownMs - 1;
    skill.cast(client("caster"), AHEAD);
    assert.strictEqual(casts().length, 1);
    clock.currentTime = WATER_CLONE.lifetimeMs + WATER_CLONE.cooldownMs;
    skill.cast(client("caster"), AHEAD);
    assert.strictEqual(casts().length, 2);
  });

  it("walks at a mage's pace toward its target, facing it, and stops within whip range", () => {
    const { skill, join, client, cloneOf, steps } = fakeRoom();
    join("caster", 100, 300).yaw = -Math.PI / 2;
    const enemy = join("enemy", 700, 300, "fire");

    // Facing +x (yaw -π/2), straight at the enemy.
    skill.cast(client("caster"), { yaw: -Math.PI / 2, pitch: 0 });
    const [, clone] = cloneOf("caster")!;
    const startX = clone.x;
    steps(TICK_RATE / 2);
    assert.ok(Math.abs(clone.x - startX - PLAYER_SPEED / 2) < 1, `walked ${clone.x - startX} in half a second`);
    assert.ok(Math.abs(clone.yaw + Math.PI / 2) < 1e-6, "faces +x");

    steps(TICK_RATE * 3);
    const gap = enemy.x - clone.x;
    assert.ok(gap <= WATER_CLONE.stopRange && gap > WATER_CLONE.stopRange - PLAYER_SPEED * DT - 1e-9, `stopped ${gap} short`);
    const at = clone.x;
    steps(10);
    assert.strictEqual(clone.x, at, "stays put in range");
  });

  it("is slowed like a player", () => {
    const { skill, join, client, cloneOf, steps } = fakeRoom();
    join("caster", 100, 300);
    join("enemy", 700, 300, "fire");

    skill.cast(client("caster"), { yaw: -Math.PI / 2, pitch: 0 });
    const [, clone] = cloneOf("caster")!;
    clone.effects.push("slow");
    const startX = clone.x;
    steps(TICK_RATE / 2);
    const expected = (PLAYER_SPEED * EFFECTS.slow.moveSpeedScale!) / 2;
    assert.ok(Math.abs(clone.x - startX - expected) < 1, `walked ${clone.x - startX}, slowed`);
  });

  it("lashes its target with the whip in range, credited to its owner and never at them; not while frozen", () => {
    const { skill, join, client, cloneOf, steps, attacks } = fakeRoom();
    join("caster", 400, 300);
    join("enemy", 400, 200, "fire");

    skill.cast(client("caster"), AHEAD);
    const [id, clone] = cloneOf("caster")!;
    steps(3);
    assert.strictEqual(attacks.length, 3, "asks every step; the whip's own cooldown decides");
    const [attack] = attacks;
    assert.strictEqual(attack.attackerId, id);
    assert.deepStrictEqual(attack.source, { id: "caster", name: "caster", ability: "water_clone" });
    assert.ok(attack.ignore?.has("caster"));
    assert.strictEqual(attack.damage, 5, "half a mage's whip");
    assert.ok(Math.abs(attack.aim.yaw) < 1e-9, "aimed along -y at the enemy");
    assert.ok(attack.aim.pitch < 0, "down a little, from its eyes to their middle");

    clone.effects.push("frozen");
    steps(5);
    assert.strictEqual(attacks.length, 3);
  });

  it("never lashes a target high above it, like a mage soaring in Skyfall, only once they are back in reach", () => {
    const { state, skill, join, client, steps, attacks } = fakeRoom();
    join("caster", 400, 300);
    join("enemy", 400, 200, "wind");
    const enemy = state.players.get("enemy")!;

    skill.cast(client("caster"), AHEAD);
    enemy.z = 420;
    enemy.flightZ = 420;
    steps(3);
    assert.strictEqual(attacks.length, 0, "out of reach in the sky");

    enemy.flightZ = 0;
    enemy.z = WATER_CLONE.attackHeight - 1;
    steps(1);
    assert.strictEqual(attacks.length, 1, "a jump's height is still in reach");
  });

  it("goes after someone else once its target is down or out of reach", () => {
    const { skill, join, client, steps, attacks } = fakeRoom();
    join("caster", 400, 300);
    const first = join("first", 400, 200, "fire");
    const second = join("second", 300, 260, "earth");

    skill.cast(client("caster"), AHEAD);
    steps(1);
    assert.ok(Math.abs(attacks.at(-1)!.aim.yaw) < 1e-9, "at the first");

    first.hp = 0;
    steps(1);
    const toSecond = Math.atan2(-(second.x - attacks.at(-1)!.at.x), -(second.y - attacks.at(-1)!.at.y));
    assert.ok(Math.abs(attacks.at(-1)!.aim.yaw - toSecond) < 1e-6, "at the second");

    first.hp = MAX_HP;
    second.effects.push("burrowed");
    steps(1);
    assert.ok(Math.abs(attacks.at(-1)!.aim.yaw) < 1e-6, "back at the first");
  });

  it("goes when its owner dies or leaves", () => {
    const { state, skill, join, client, ends, cloneOf, steps, gone, whipRemoved } = fakeRoom();
    const owner = join("caster", 400, 300);
    join("other", 200, 300);

    skill.cast(client("caster"), AHEAD);
    skill.cast(client("other"), AHEAD);
    const [ownersClone] = cloneOf("caster")!;
    const [othersClone] = cloneOf("other")!;

    owner.hp = 0;
    steps(1);
    assert.deepStrictEqual(ends().map((e) => [e.cloneId, e.reason]), [[ownersClone, "owner"]]);
    assert.ok(!state.players.has(ownersClone));

    state.players.delete("other");
    skill.remove("other");
    assert.deepStrictEqual(ends().map((e) => [e.cloneId, e.reason]), [[ownersClone, "owner"], [othersClone, "owner"]]);
    assert.ok(!state.players.has(othersClone));
    assert.deepStrictEqual(gone, [ownersClone, othersClone], "the room hears of each, to drop what it kept");
    assert.deepStrictEqual(whipRemoved, [ownersClone, othersClone]);
  });

  it("goes on a fresh round, with no cooldown after", () => {
    const { state, skill, join, client, casts, ends, cloneOf } = fakeRoom();
    join("caster", 400, 300);

    skill.cast(client("caster"), AHEAD);
    const [id] = cloneOf("caster")!;
    skill.reset();
    assert.deepStrictEqual(ends().map((e) => [e.cloneId, e.reason, e.cooldownMs]), [[id, "reset", 0]]);
    assert.ok(!state.players.has(id));
    skill.cast(client("caster"), AHEAD);
    assert.strictEqual(casts().length, 2);
  });

  it("takes no hits from its owner, but from everyone else", () => {
    // The fake room's damage drops hits the way `MyRoom.damage` does: by `sparedAsOwnClone`.
    const { state, skill, join, client, cloneOf, damage } = fakeRoom();
    join("caster", 400, 300);
    join("enemy", 100, 100, "fire");

    skill.cast(client("caster"), AHEAD);
    const [id, clone] = cloneOf("caster")!;
    damage(id, 5, { id: "caster", name: "caster", ability: "water_whip" });
    assert.strictEqual(clone.hp, WATER_CLONE.hp);
    damage(id, 5, { id: "enemy", name: "enemy", ability: "fireball" });
    assert.strictEqual(clone.hp, WATER_CLONE.hp - 5);
    assert.ok(!sparedAsOwnClone(state.players.get("caster"), "caster"), "a real player is never a clone");
    assert.ok(!isWaterClone(state.players.get("enemy")));
  });
});
