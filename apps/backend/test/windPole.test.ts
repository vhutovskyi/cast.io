import assert from "assert";
import type { Client, Clock } from "colyseus";

import { MyRoomState, Player, Wall } from "../src/rooms/schema/MyRoomState.js";
import { ARENA_WIDTH, MAX_HP, PITCH_LIMIT, PLAYER_HALF, TICK_RATE } from "../src/shared/constants.js";
import { SERVER_MESSAGE } from "../src/shared/messages.js";
import type { DamageSource } from "../src/shared/combat.js";
import { LIVE, type SeenAt, type SkillRoom } from "../src/skills/skillRoom.js";
import { WindPoleSkill } from "../src/skills/windPole/windPole.js";
import {
  WIND_BLAST_LIFETIME_S, WIND_BLAST_STEP_S, WIND_POLE, launchWindBlast, poleStrike, windBlastPosition, windBlastStruck,
  windBlastSurfaceHit, type WindPoleCast, type WindPoleHit,
} from "../src/skills/windPole/windPoleConfig.js";

/** Aims along +x (at yaw 0 forward is -y; turning a quarter right faces +x). */
const EAST = -Math.PI / 2;
const DT = 1 / TICK_RATE;
/** Within the pole's reach: bodies a few units apart, edge to edge. */
const NEAR = 2 * PLAYER_HALF + 10;

/** A room stand-in: real state, a clock the test moves by hand, and everything the skill does, recorded. */
function fakeRoom() {
  const state = new MyRoomState();
  const clock = { currentTime: 0 } as Clock;
  const hits: { sessionId: string; amount: number; source?: DamageSource }[] = [];
  const casts: WindPoleCast[] = [];
  const breaks: WindPoleHit[] = [];
  /** Lag compensation, set by hand: how far behind each caster saw everyone, and what everyone looked like that long ago. */
  const lag = { ms: 0, seenAgo: (_lagMs: number): SeenAt => LIVE };
  const room: SkillRoom = {
    state,
    clock,
    broadcast(type, message) {
      if (type === SERVER_MESSAGE.windPoleCast) { casts.push(message as WindPoleCast); }
      if (type === SERVER_MESSAGE.windPoleHit) { breaks.push(message as WindPoleHit); }
    },
    send() {},
    damage(sessionId, amount, source) {
      const player = state.players.get(sessionId);
      if (!player || player.hp <= 0) { return; }
      hits.push({ sessionId, amount, source });
      player.hp = Math.max(0, player.hp - amount);
    },
    removeEffect() {},
    applyEffect: () => false,
    addGroundZone: () => 0,
    seenBy: () => lag.seenAgo(lag.ms),
    lagOf: () => lag.ms,
    canAct: (sessionId: string) => (state.players.get(sessionId)?.hp ?? 0) > 0,
    seenAgo: (lagMs) => lag.seenAgo(lagMs),
  };
  const skill = new WindPoleSkill(room);
  const join = (sessionId: string, x: number, y: number, element = "wind") => {
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
  return { skill, state, join, client, fly, clock, hits, casts, breaks, lag };
}

const source = { id: "caster", name: "caster", ability: "wind_pole" };

describe("wind pole", () => {
  describe("config", () => {
    it("ships 6 melee damage, 8 for the gust and a short cooldown", () => {
      assert.strictEqual(WIND_POLE.meleeDamage, 6);
      assert.strictEqual(WIND_POLE.blastDamage, 8);
      assert.ok(WIND_POLE.cooldownMs >= 500 && WIND_POLE.cooldownMs <= 700);
    });

    it("launches the gust at eye height, along the view, at full speed, in a straight line", () => {
      const launch = launchWindBlast({ x: 100, y: 300, z: 0 }, { yaw: EAST, pitch: 0 });
      assert.ok(Math.abs(launch.y - (300 + WIND_POLE.handOffset)) < 1e-9, "facing +x, the right hand is toward +y");
      assert.ok(Math.abs(launch.vx - WIND_POLE.speed) < 1e-9 && launch.vz === 0);
      const later = windBlastPosition(launch, 0.2);
      assert.strictEqual(later.z, launch.z, "no drop");
      assert.ok(Math.abs(later.x - (launch.x + WIND_POLE.speed * 0.2)) < 1e-9);

      const up = launchWindBlast({ x: 100, y: 300, z: 0 }, { yaw: 0, pitch: 10 });
      assert.ok(Math.abs(up.vz - Math.sin(PITCH_LIMIT) * WIND_POLE.speed) < 1e-6, "pitch is clamped like the camera's");
      assert.ok(WIND_BLAST_STEP_S * WIND_POLE.speed <= WIND_POLE.radius + 1e-9, "never steps further than its radius");
    });

    it("breaks against arena walls and the floor, on the surface", () => {
      assert.strictEqual(windBlastSurfaceHit({ x: 400, y: 300, z: 30 }), null);
      assert.deepStrictEqual(windBlastSurfaceHit({ x: ARENA_WIDTH + 3, y: 300, z: 30 }), { x: ARENA_WIDTH - WIND_POLE.radius, y: 300, z: 30 });
      assert.deepStrictEqual(windBlastSurfaceHit({ x: 400, y: 300, z: -2 }), { x: 400, y: 300, z: WIND_POLE.radius });
    });

    it("the gust strikes the closest living body it touches, never the caster's", () => {
      const at = { x: 200, y: 300, z: 20 };
      const players: [string, { x: number; y: number; z: number; hp: number }][] = [
        ["caster", { x: 200, y: 300, z: 0, hp: MAX_HP }],
        ["dead", { x: 200, y: 300, z: 0, hp: 0 }],
        ["grazed", { x: 200, y: 300 + PLAYER_HALF + 4, z: 0, hp: MAX_HP }],
        ["centred", { x: 205, y: 300, z: 0, hp: MAX_HP }],
      ];
      assert.strictEqual(windBlastStruck("caster", at, players), "centred");
      assert.strictEqual(windBlastStruck("caster", at, players.slice(0, 3)), "grazed");
      assert.strictEqual(windBlastStruck("caster", at, players.slice(0, 2)), undefined);
    });

    it("the pole reaches the nearest living enemy right in front, overlapping in height", () => {
      const caster = { x: 100, y: 300, z: 0 };
      const enemy = (x: number, y: number, z = 0, hp = MAX_HP) => ({ x, y, z, hp });
      assert.strictEqual(poleStrike("caster", caster, EAST, [["a", enemy(100 + NEAR, 300)]])?.hitId, "a");
      assert.strictEqual(
        poleStrike("caster", caster, EAST, [["far", enemy(100 + NEAR + 5, 300)], ["near", enemy(100 + NEAR - 5, 300)]])?.hitId,
        "near",
      );
      assert.strictEqual(poleStrike("caster", caster, EAST, [["dead", enemy(100 + NEAR, 300, 0, 0)]]), null, "not the dead");
      assert.strictEqual(poleStrike("caster", caster, EAST, [["behind", enemy(100 - NEAR, 300)]]), null, "not behind");
      assert.strictEqual(poleStrike("caster", caster, EAST, [["aside", enemy(100, 300 + NEAR)]]), null, "not beside");
      assert.strictEqual(poleStrike("caster", caster, EAST, [["out", enemy(100 + WIND_POLE.meleeReach + PLAYER_HALF + 1, 300)]]), null, "not out of reach");
      assert.strictEqual(poleStrike("caster", caster, EAST, [["up", enemy(100 + NEAR, 300, 60)]]), null, "not high above");
      assert.strictEqual(poleStrike("caster", caster, EAST, [["hop", enemy(100 + NEAR, 300, 20)]])?.hitId, "hop", "a hop still overlaps");
      const strike = poleStrike("caster", caster, EAST, [["a", enemy(100 + NEAR, 300)]]);
      assert.ok(strike && Math.abs(strike.x - (100 + NEAR - PLAYER_HALF)) < 1e-9, "lands on the body's near side");
    });
  });

  describe("server skill", () => {
    it("only wind mages with Wind Pole in their kit, alive, may swing", () => {
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
      skill.cast(client("caster"), { yaw: EAST, pitch: 0 });
      assert.strictEqual(casts.length, 1);
    });

    it("an enemy right in front takes the pole itself: 12 damage, at once, and no gust", () => {
      const { skill, join, client, fly, hits, casts, breaks } = fakeRoom();
      join("caster", 100, 300);
      join("target", 100 + NEAR, 300);
      join("behind", 100 + NEAR + 30, 300);
      skill.cast(client("caster"), { yaw: EAST, pitch: 0 });

      assert.deepStrictEqual(hits, [{ sessionId: "target", amount: WIND_POLE.meleeDamage, source }]);
      assert.strictEqual(casts.length, 1);
      const [cast] = casts;
      assert.ok(cast.kind === "strike" && cast.strike.hitId === "target");
      assert.strictEqual(cast.cooldownMs, WIND_POLE.cooldownMs);
      fly(1);
      assert.strictEqual(hits.length, 1, "nothing else lands");
      assert.strictEqual(breaks.length, 0);
    });

    it("with no one in reach, throws a gust: 8 damage to the first enemy it meets, alone", () => {
      const { skill, join, client, fly, hits, casts, breaks } = fakeRoom();
      join("caster", 100, 300);
      join("corpse", 200, 300).hp = 0;
      join("first", 300, 300);
      join("behind", 340, 300);
      skill.cast(client("caster"), { yaw: EAST, pitch: 0 });

      assert.strictEqual(hits.length, 0, "not instant");
      assert.deepStrictEqual(casts[0], {
        kind: "blast", id: 1, casterId: "caster", cooldownMs: WIND_POLE.cooldownMs, ...launchWindBlast({ x: 100, y: 300, z: 0 }, { yaw: EAST, pitch: 0 }),
      });
      fly(1);
      assert.deepStrictEqual(hits, [{ sessionId: "first", amount: WIND_POLE.blastDamage, source }]);
      assert.strictEqual(breaks.length, 1);
      assert.strictEqual(breaks[0].hitId, "first");
      assert.ok(Math.abs(breaks[0].x - (300 - PLAYER_HALF - WIND_POLE.radius)) <= WIND_POLE.radius, "breaks at the body's front");
    });

    it("holds the next swing for the cooldown", () => {
      const { skill, join, client, clock, casts } = fakeRoom();
      join("caster", 100, 300);
      skill.cast(client("caster"), { yaw: EAST, pitch: 0 });
      clock.currentTime += WIND_POLE.cooldownMs - 1;
      skill.cast(client("caster"), { yaw: EAST, pitch: 0 });
      assert.strictEqual(casts.length, 1, "too early");
      clock.currentTime += 1;
      skill.cast(client("caster"), { yaw: EAST, pitch: 0 });
      assert.strictEqual(casts.length, 2);
    });

    it("a raised wall shields an enemy from both the pole and the gust", () => {
      const { skill, state, join, client, fly, hits, casts, breaks } = fakeRoom();
      join("caster", 100, 300);
      join("near", 100 + NEAR, 300);
      join("far", 300, 300);
      state.walls.set("1", new Wall({ ownerId: "someone", kind: "wall", x: 100 + PLAYER_HALF + 3, y: 300, angle: Math.PI / 2, halfLength: 60, halfThickness: 2, height: 80 }));
      skill.cast(client("caster"), { yaw: EAST, pitch: 0 });
      fly(1);

      assert.strictEqual(hits.length, 0);
      assert.strictEqual(casts[0].kind, "blast", "the pole can't reach through it, so the swing throws");
      assert.strictEqual(breaks.length, 1);
      assert.strictEqual(breaks[0].hitId, undefined);
      assert.ok(breaks[0].x < 100 + NEAR, "breaks on the wall");
    });

    it("breaks on the floor when thrown down, and dies out at the end of its range", () => {
      const { skill, join, client, clock, fly, breaks } = fakeRoom();
      join("caster", 100, 300);
      skill.cast(client("caster"), { yaw: EAST, pitch: -0.6 });
      fly(1);
      assert.strictEqual(breaks.length, 1);
      assert.strictEqual(breaks[0].z, WIND_POLE.radius);

      clock.currentTime += WIND_POLE.cooldownMs;
      join("beyond", 100 + WIND_POLE.handOffset + WIND_POLE.range + 40, 300);
      skill.cast(client("caster"), { yaw: EAST, pitch: 0 });
      fly(WIND_BLAST_LIFETIME_S + 1);
      assert.strictEqual(breaks.length, 1, "nothing reached");
    });

    it("a fresh round: cooldowns go and gusts in the air vanish", () => {
      const { skill, join, client, fly, casts, breaks } = fakeRoom();
      join("caster", 100, 300);
      join("target", 400, 300);
      skill.cast(client("caster"), { yaw: EAST, pitch: 0 });
      skill.reset();
      fly(1);
      assert.strictEqual(breaks.length, 0);
      skill.cast(client("caster"), { yaw: EAST, pitch: 0 });
      assert.strictEqual(casts.length, 2, "ready again right away");
    });

    it("the gust strikes whoever stood in its path on the caster's screen, though they've moved since", () => {
      const { skill, join, client, fly, hits, breaks, lag } = fakeRoom();
      join("caster", 100, 300);
      const target = join("target", 300, 300);
      const seenAt = { x: 300, y: 300, z: 0 };
      target.y = 300 + 4 * PLAYER_HALF; // stepped out of the line since
      lag.ms = 150;
      const asked: number[] = [];
      lag.seenAgo = (lagMs) => {
        asked.push(lagMs);
        return lagMs === 150 ? (player) => (player === target ? seenAt : player) : LIVE;
      };
      skill.cast(client("caster"), { yaw: EAST, pitch: 0 });
      lag.ms = 0; // the caster's lag now no longer matters: the gust keeps what it was thrown with
      fly(1);

      assert.deepStrictEqual(hits, [{ sessionId: "target", amount: WIND_POLE.blastDamage, source }]);
      assert.strictEqual(breaks[0].hitId, "target");
      assert.ok(asked.length > 0 && asked.every((ms) => ms === 150), "every hit test reads the world as the caster saw it");
      assert.strictEqual(target.y, 300 + 4 * PLAYER_HALF, "only read in the past: nobody is moved");
    });

    it("with no lag the gust flies through where everyone is now", () => {
      const { skill, join, client, fly, hits, breaks } = fakeRoom();
      join("caster", 100, 300);
      join("target", 300, 300).y = 300 + 4 * PLAYER_HALF;
      join("stepped in", 340, 300);
      skill.cast(client("caster"), { yaw: EAST, pitch: 0 });
      fly(1);

      assert.deepStrictEqual(hits, [{ sessionId: "stepped in", amount: WIND_POLE.blastDamage, source }]);
      assert.strictEqual(breaks[0].hitId, "stepped in");
    });

    it("a caster leaving: their gust still lands, their cooldown goes", () => {
      const { skill, join, client, fly, casts, hits } = fakeRoom();
      join("caster", 100, 300);
      join("target", 300, 300);
      skill.cast(client("caster"), { yaw: EAST, pitch: 0 });
      skill.remove("caster");
      fly(1);
      assert.strictEqual(hits.length, 1);
      skill.cast(client("caster"), { yaw: EAST, pitch: 0 });
      assert.strictEqual(casts.length, 2);
    });
  });
});
