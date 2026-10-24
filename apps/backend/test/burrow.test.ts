import assert from "assert";
import type { Client, Clock } from "colyseus";
import { LIVE, type SeenAt } from "../src/skills/skillRoom.js";

import { MyRoomState, Player } from "../src/rooms/schema/MyRoomState.js";
import { JUMP_SPEED, MAX_HP, PLAYER_SPEED, TICK_RATE } from "../src/shared/constants.js";
import type { DamageSource } from "../src/shared/combat.js";
import { SERVER_MESSAGE } from "../src/shared/messages.js";
import { blockedByWalls, canCast, isUntargetable, moveLimits, type EffectId } from "../src/effects/effectConfig.js";
import { clearForcedMotion, stepEntity, type MoveInputLike } from "../src/shared/movement.js";
import type { Obstacle } from "../src/shared/obstacles.js";
import { BurrowSkill, STALLED_PHASE_MS } from "../src/skills/burrow/burrow.js";
import { BURROW, BURROW_SPEED, type BurrowCast, type BurrowSurface } from "../src/skills/burrow/burrowConfig.js";

/** One server tick, in seconds. */
const DT = 1 / TICK_RATE;
/** Not walking, not jumping: only what the skill does moves them. */
const STILL: MoveInputLike = { moveX: 0, moveY: 0, yaw: 0, jump: false, breath: false };
/** Walking straight ahead (-y at yaw 0). */
const AHEAD: MoveInputLike = { ...STILL, moveY: -1 };

/**
 * A room stand-in: real state, a clock the test moves by hand, the shared
 * movement step for everyone, and records of what the skill asked the room
 * to do (no Colyseus server is booted). Effects go straight onto the synced
 * list and come off it, and damage skips the untargetable — as the room's do.
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
      if (!player || player.hp <= 0 || isUntargetable(player.effects)) { return; }
      hits.push({ sessionId, amount, source });
      player.hp = Math.max(0, player.hp - amount);
      if (player.hp === 0) {
        player.effects.clear();
        clearForcedMotion(player);
      }
    },
    removeEffect(sessionId: string, id: EffectId) {
      const effects = state.players.get(sessionId)?.effects;
      const index = effects?.indexOf(id) ?? -1;
      if (effects && index >= 0) { effects.splice(index, 1); }
    },
    applyEffect(sessionId: string, id: EffectId, source?: DamageSource, durationMs?: number) {
      const player = state.players.get(sessionId);
      if (!player || player.hp <= 0) { return false; }
      if (isUntargetable(player.effects) && source?.id !== sessionId) { return false; }
      applied.push({ sessionId, id, source, durationMs });
      if (!player.effects.includes(id)) { player.effects.push(id); }
      return true;
    },
    addGroundZone() { return 0; },
    /** Lag compensation: where the caster saw everyone (LIVE unless a test sets it), and who asked. */
    seen: LIVE as SeenAt,
    seenAsked: [] as string[],
    seenBy(sessionId: string): SeenAt { room.seenAsked.push(sessionId); return room.seen; },
    lagOf: () => 0,
    seenAgo: () => LIVE,
  };
  const skill = new BurrowSkill(room);
  const join = (sessionId: string, x: number, y: number, element = "earth") => {
    const player = new Player({ name: sessionId, hp: MAX_HP, element, x, y, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, dashVx: 0, dashVy: 0, dashTime: 0, flightZ: 0, breathing: false, ready: false, wins: 0, ownerId: "" });
    state.players.set(sessionId, player);
    return player;
  };
  const client = (sessionId: string) => ({ sessionId }) as Client;
  /** Runs `ms` worth of server ticks: everyone steps once (`inputs` by id, else still), then the skill. */
  const run = (ms: number, inputs: Record<string, MoveInputLike> = {}) => {
    // Counted in whole ticks from the start, so the clock lands exactly on each phase's end.
    const start = clock.currentTime;
    for (let tick = 1; tick <= Math.round(ms / (DT * 1000)); tick++) {
      clock.currentTime = start + (tick * 1000) / TICK_RATE;
      for (const [sessionId, player] of state.players) {
        const walls: Iterable<Obstacle> = blockedByWalls(player.effects) ? state.walls.values() : [];
        stepEntity(player, inputs[sessionId] ?? STILL, DT, moveLimits(player.effects), walls);
        skill.afterInput(sessionId, player);
      }
      skill.step();
    }
  };
  const casts = () => sent.filter((m) => m.type === SERVER_MESSAGE.burrowCast).map((m) => m.message as BurrowCast);
  const surfaces = () => sent.filter((m) => m.type === SERVER_MESSAGE.burrowSurface).map((m) => m.message as BurrowSurface);
  return { state, skill, join, client, run, casts, surfaces, hits, applied, clock, room };
}

/** Effects the skill keeps on a player, in the order they are on the list. */
const burrowEffects = (player: Player) => [...player.effects].filter((id) => id === "burrowing" || id === "burrowed");

describe("burrow", () => {
  it("digs in rooted, tells everyone, then travels under the ground", () => {
    const { skill, join, client, run, casts, applied } = fakeRoom();
    const caster = join("caster", 400, 500);

    skill.cast(client("caster"));
    assert.deepStrictEqual(casts(), [{
      casterId: "caster", cooldownMs: BURROW.cooldownMs, x: 400, y: 500, z: 0, digMs: BURROW.digMs, underMs: BURROW.underMs,
    }]);
    assert.deepStrictEqual(burrowEffects(caster), ["burrowing"]);
    assert.deepStrictEqual(applied.map((a) => [a.id, a.source?.id, a.source?.ability, a.durationMs]), [["burrowing", "caster", "burrow", BURROW.digMs + STALLED_PHASE_MS]]);
    assert.ok(!canCast(caster.effects), "no casting while digging");
    assert.ok(isUntargetable(caster.effects), "out of reach while digging");

    // Rooted while digging: walking goes nowhere.
    run(BURROW.digMs - 100, { caster: AHEAD });
    assert.deepStrictEqual(burrowEffects(caster), ["burrowing"]);
    assert.strictEqual(caster.y, 500);

    run(100);
    assert.deepStrictEqual(burrowEffects(caster), ["burrowed"]);
    assert.deepStrictEqual(applied.at(-1)?.durationMs, BURROW.underMs + STALLED_PHASE_MS);
    assert.ok(isUntargetable(caster.effects) && !blockedByWalls(caster.effects) && !canCast(caster.effects));
  });

  it("clears every effect on the caster as they start digging", () => {
    const { skill, join, client } = fakeRoom();
    const caster = join("caster", 400, 500);
    caster.effects.push("burn", "slow", "stone_skin");

    skill.cast(client("caster"));
    assert.deepStrictEqual([...caster.effects], ["burrowing"]);
  });

  it("travels under the ground at 2.5 × a walk", () => {
    const { skill, join, client, run } = fakeRoom();
    const caster = join("caster", 400, 550);

    skill.cast(client("caster"));
    run(BURROW.digMs);
    assert.strictEqual(moveLimits(caster.effects).speedScale, BURROW.speedScale);
    assert.strictEqual(moveLimits(caster.effects).canJump, false);
    assert.strictEqual(BURROW_SPEED, PLAYER_SPEED * 2.5);

    run(500, { caster: AHEAD });
    assert.ok(Math.abs(caster.y - (550 - BURROW_SPEED * 0.5)) < 1e-6, `at y ${caster.y}`);
    assert.strictEqual(caster.z, 0, "still on (under) the ground");
  });

  it("bursts out on a click while under, hurting the near and sparing the caster, the far and the high", () => {
    const { skill, join, client, run, hits, surfaces, state } = fakeRoom();
    const caster = join("caster", 400, 300);
    join("near", 400 + BURROW.eruptRadius - 1, 300);
    join("far", 400 + BURROW.eruptRadius + 1, 300);
    // Hovering, so it is still up there when the burst comes.
    const high = join("high", 400, 330);
    high.z = high.flightZ = 80;
    join("corpse", 410, 300).hp = 0;

    skill.cast(client("caster"));
    run(BURROW.digMs + 200);
    skill.erupt(client("caster"));

    assert.deepStrictEqual(hits.map((h) => [h.sessionId, h.amount, h.source?.id, h.source?.ability]), [["near", BURROW.eruptDamage, "caster", "burrow"]]);
    assert.deepStrictEqual(surfaces(), [{ casterId: "caster", x: 400, y: 300, z: 0, erupted: true, hits: ["near"] }]);
    assert.deepStrictEqual(burrowEffects(caster), []);
    assert.strictEqual(caster.vz, BURROW.eruptJumpSpeed);
    assert.strictEqual(state.players.get("caster")!.hp, MAX_HP);

    // The next movement step takes off from the floor, higher than a jump would.
    run(DT * 1000);
    assert.ok(caster.z > 0, `took off, at z ${caster.z}`);
    let top = caster.z;
    for (let i = 0; i < TICK_RATE && caster.z > 0; i++) {
      run(DT * 1000);
      top = Math.max(top, caster.z);
    }
    assert.ok(top > (JUMP_SPEED * JUMP_SPEED) / (2 * 700), `peaked at ${top}`);

    // Once only: a second click, or the time running out, does nothing more.
    skill.erupt(client("caster"));
    run(BURROW.underMs);
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(surfaces().length, 1);
  });

  it("a burst hits an enemy where the caster saw them, though they have walked out of reach since", () => {
    const { skill, join, client, run, hits, surfaces, room } = fakeRoom();
    join("caster", 400, 300);
    const runner = join("runner", 400 + BURROW.eruptRadius + 50, 300);
    const seenAt = { x: 400 + BURROW.eruptRadius - 1, y: 300, z: 0 };

    skill.cast(client("caster"));
    run(BURROW.digMs + 200);
    // On the caster's screen the runner is still inside the burst; live they are out of it.
    room.seen = (player) => (player === runner ? seenAt : player);
    skill.erupt(client("caster"));

    assert.deepStrictEqual(room.seenAsked, ["caster"]);
    assert.deepStrictEqual(hits.map((h) => h.sessionId), ["runner"]);
    assert.deepStrictEqual(surfaces()[0].hits, ["runner"]);
    // Only the hit test is rewound: the runner itself is not moved.
    assert.strictEqual(runner.x, 400 + BURROW.eruptRadius + 50);
  });

  it("with no lag a burst reads everyone live", () => {
    const { skill, join, client, run, hits, room } = fakeRoom();
    join("caster", 400, 300);
    join("near", 400 + BURROW.eruptRadius - 1, 300);
    join("far", 400 + BURROW.eruptRadius + 1, 300);

    skill.cast(client("caster"));
    run(BURROW.digMs + 200);
    assert.strictEqual(room.seen, LIVE);
    skill.erupt(client("caster"));
    assert.deepStrictEqual(hits.map((h) => h.sessionId), ["near"]);
  });

  it("spares another mage who is under the ground too", () => {
    const { skill, join, client, run, hits, surfaces } = fakeRoom();
    join("caster", 400, 300);
    const other = join("other", 420, 300);

    skill.cast(client("caster"));
    skill.cast(client("other"));
    run(BURROW.digMs);
    skill.erupt(client("caster"));
    assert.strictEqual(hits.length, 0);
    assert.deepStrictEqual(surfaces()[0].hits, []);
    assert.deepStrictEqual(burrowEffects(other), ["burrowed"]);
  });

  it("ignores a burst while still digging in, and from anyone not under", () => {
    const { skill, join, client, run, hits, surfaces } = fakeRoom();
    const caster = join("caster", 400, 300);
    join("near", 420, 300);

    skill.erupt(client("caster"));
    skill.erupt(client("nobody"));
    skill.cast(client("caster"));
    run(BURROW.digMs - 100);
    skill.erupt(client("caster"));
    assert.strictEqual(surfaces().length, 0);
    assert.deepStrictEqual(burrowEffects(caster), ["burrowing"]);
    assert.strictEqual(caster.vz, 0);

    // Still under the way it was going: the early click didn't cancel anything.
    run(100);
    assert.deepStrictEqual(burrowEffects(caster), ["burrowed"]);
    assert.strictEqual(hits.length, 0);
  });

  it("surfaces quietly once the time is up, hurting no one", () => {
    const { skill, join, client, run, hits, surfaces } = fakeRoom();
    const caster = join("caster", 400, 300);
    join("near", 410, 300);

    skill.cast(client("caster"));
    run(BURROW.digMs + BURROW.underMs - 100);
    assert.deepStrictEqual(burrowEffects(caster), ["burrowed"]);
    assert.strictEqual(surfaces().length, 0);

    run(100);
    assert.deepStrictEqual(burrowEffects(caster), []);
    assert.deepStrictEqual(surfaces(), [{ casterId: "caster", x: 400, y: 300, z: 0, erupted: false, hits: [] }]);
    assert.strictEqual(hits.length, 0);
    assert.strictEqual(caster.vz, 0, "no jump out");

    // Too late to burst out now.
    skill.erupt(client("caster"));
    assert.strictEqual(surfaces().length, 1);
  });

  it("refuses a second burrow until the cooldown is over, and while one is going", () => {
    const { skill, join, client, run, casts, clock } = fakeRoom();
    join("caster", 400, 300);

    skill.cast(client("caster"));
    skill.cast(client("caster"));
    assert.strictEqual(casts().length, 1);
    run(BURROW.digMs + BURROW.underMs);
    clock.currentTime = BURROW.cooldownMs - 1;
    skill.cast(client("caster"));
    assert.strictEqual(casts().length, 1);
    clock.currentTime = BURROW.cooldownMs;
    skill.cast(client("caster"));
    assert.strictEqual(casts().length, 2);
  });

  it("drops casts from other elements, the dead, strangers and anyone off the ground", () => {
    const { skill, join, client, casts } = fakeRoom();
    const wind = join("wind", 400, 300, "wind");
    join("dead", 400, 300).hp = 0;
    const jumper = join("jumper", 400, 300);
    jumper.z = 20;
    jumper.vz = 120;
    const flier = join("flier", 400, 300);
    flier.flightZ = 400;

    for (const id of ["wind", "dead", "nobody", "jumper", "flier"]) { skill.cast(client(id)); }
    assert.strictEqual(casts().length, 0);
    assert.deepStrictEqual(burrowEffects(wind), []);
    assert.deepStrictEqual(burrowEffects(jumper), []);

    // Back on the ground, the jumper's cooldown wasn't spent.
    jumper.z = 0;
    jumper.vz = 0;
    skill.cast(client("jumper"));
    assert.strictEqual(casts().length, 1);
  });

  it("a caster who dies mid-burrow just goes: no surfacing, no burst", () => {
    const { skill, join, client, run, surfaces, hits } = fakeRoom();
    const caster = join("caster", 400, 300);
    join("near", 410, 300);

    skill.cast(client("caster"));
    run(BURROW.digMs + 200);
    // The room clears a dead body's effects.
    caster.hp = 0;
    caster.effects.clear();
    run(100);
    skill.erupt(client("caster"));

    // Back to life: the old burrow is gone for good.
    caster.hp = MAX_HP;
    run(BURROW.underMs);
    skill.erupt(client("caster"));
    assert.strictEqual(surfaces().length, 0);
    assert.strictEqual(hits.length, 0);
    assert.deepStrictEqual(burrowEffects(caster), []);
  });

  it("a fresh round clears cooldowns and burrows; leaving clears both too", () => {
    const { skill, join, client, run, casts, surfaces } = fakeRoom();
    const caster = join("caster", 400, 300);

    skill.cast(client("caster"));
    run(BURROW.digMs);
    skill.reset();
    caster.effects.clear();
    run(BURROW.underMs);
    skill.erupt(client("caster"));
    assert.strictEqual(surfaces().length, 0, "the burrow vanished with the round");

    skill.cast(client("caster"));
    assert.strictEqual(casts().length, 2, "the cooldown went too");
    skill.remove("caster");
    caster.effects.clear();
    skill.cast(client("caster"));
    assert.strictEqual(casts().length, 3, "leaving dropped the cooldown and the burrow");
  });
});
