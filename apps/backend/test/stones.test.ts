import assert from "assert";
import type { Client, Clock } from "colyseus";

import { MyRoomState, Player, Wall } from "../src/rooms/schema/MyRoomState.js";
import { ARENA_WIDTH, MAX_HP, TICK_RATE } from "../src/shared/constants.js";
import { SERVER_MESSAGE } from "../src/shared/messages.js";
import type { DamageSource } from "../src/shared/combat.js";
import { LIVE, type SeenPoint, type SkillRoom } from "../src/skills/skillRoom.js";
import { StonesSkill } from "../src/skills/stones/stones.js";
import {
  STONE_FISTS, fistPosition, fistStepFrom, fistStruck, fistSurfaceHit, launchFist, otherSide,
  type StoneFistHit, type StoneFistPunched,
} from "../src/skills/stones/stonesConfig.js";

/** Aims along +x (at yaw 0 forward is -y; turning a quarter right faces +x, and right is then +y). */
const EAST = -Math.PI / 2;
const DT = 1 / TICK_RATE;
const AIM = { yaw: EAST };

/** A room stand-in: real state, a clock the test moves by hand, and everything the skill does, recorded. */
function fakeRoom() {
  const state = new MyRoomState();
  const clock = { currentTime: 0 } as Clock;
  const hits: { sessionId: string; amount: number; source?: DamageSource }[] = [];
  const punches: StoneFistPunched[] = [];
  const breaks: StoneFistHit[] = [];
  /** What `lagOf` says of every caster, and where `seenAgo` has players stood any time ago but now. */
  let lag = 0;
  const past = new Map<Player, SeenPoint>();
  const room: SkillRoom = {
    state,
    clock,
    broadcast(type, message) {
      if (type === SERVER_MESSAGE.stoneFistPunched) { punches.push(message as StoneFistPunched); }
      if (type === SERVER_MESSAGE.stoneFistHit) { breaks.push(message as StoneFistHit); }
    },
    send() {},
    damage(sessionId, amount, source) {
      const player = state.players.get(sessionId);
      if (!player || player.hp <= 0) { return; }
      hits.push({ sessionId, amount, source });
      player.hp = Math.max(0, player.hp - amount);
    },
    applyEffect: () => false,
    removeEffect: () => {},
    addGroundZone: () => 0,
    seenBy: () => LIVE,
    lagOf: () => lag,
    seenAgo: (lagMs) => (lagMs > 0 ? (player) => past.get(player) ?? player : LIVE),
  };
  const skill = new StonesSkill(room);
  const join = (sessionId: string, x: number, y: number, element = "earth") => {
    const player = new Player({ name: sessionId, hp: MAX_HP, element, x, y, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, dashVx: 0, dashVy: 0, dashTime: 0, flightZ: 0, breathing: false, ready: false, wins: 0, ownerId: "" });
    state.players.set(sessionId, player);
    return player;
  };
  const client = (sessionId: string) => ({ sessionId }) as Client;
  /** Moves the clock on by `ms` without stepping anything. */
  const wait = (ms: number) => { clock.currentTime += ms; };
  /** Steps the skill like the room does, a tick at a time, moving the clock along. */
  const fly = (seconds: number) => {
    for (let t = 0; t < seconds; t += DT) {
      clock.currentTime += DT * 1000;
      skill.step(DT);
    }
  };
  /** Casters see everyone `lagMs` behind, when `player` stood `at`. */
  const sawAgo = (lagMs: number, player: Player, at: SeenPoint) => { lag = lagMs; past.set(player, at); };
  return { state, skill, join, client, wait, fly, sawAgo, clock, hits, punches, breaks };
}

describe("stones (Stone Fists)", () => {
  describe("config", () => {
    it("ships fists of 6 damage, 400 ms apart", () => {
      assert.strictEqual(STONE_FISTS.damage, 6);
      assert.strictEqual(STONE_FISTS.punchIntervalMs, 400);
    });

    it("is punched from the side's hand, ahead at chest height, level along the facing, in a straight line", () => {
      const right = launchFist({ x: 100, y: 300, z: 0 }, AIM, "right");
      assert.ok(Math.abs(right.x - (100 + STONE_FISTS.handAhead)) < 1e-9, "ahead, facing +x");
      assert.ok(Math.abs(right.y - (300 + STONE_FISTS.handSide)) < 1e-9, "right of +x is +y");
      assert.strictEqual(right.z, STONE_FISTS.handHeight);
      assert.ok(Math.abs(right.vx - STONE_FISTS.speed) < 1e-9);
      assert.ok(Math.abs(right.vy) < 1e-9 && right.vz === 0);
      assert.strictEqual(fistPosition(right, 0.3).z, right.z, "never drops");

      const left = launchFist({ x: 100, y: 300, z: 0 }, AIM, "left");
      assert.ok(Math.abs(left.y - (300 - STONE_FISTS.handSide)) < 1e-9, "the left hand mirrors it");
      assert.ok(Math.abs(left.x - right.x) < 1e-9 && left.vx === right.vx && left.vy === right.vy);

      // Facing -y (yaw 0), right is +x.
      assert.ok(Math.abs(launchFist({ x: 400, y: 300, z: 0 }, { yaw: 0 }, "right").x - (400 + STONE_FISTS.handSide)) < 1e-9);
      assert.strictEqual(otherSide("right"), "left");
      assert.strictEqual(otherSide("left"), "right");
    });

    it("never steps further than its own radius", () => {
      for (const t of [0, 0.1, 0.3]) {
        const step = fistStepFrom();
        const a = launchFist({ x: 400, y: 300, z: 0 }, { yaw: 1 }, "left");
        const from = fistPosition(a, t);
        const to = fistPosition(a, t + step);
        assert.ok(Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z) <= STONE_FISTS.radius + 1e-9);
      }
    });

    it("breaks against arena walls and the floor, on the surface", () => {
      assert.strictEqual(fistSurfaceHit({ x: 400, y: 300, z: 30 }), null);
      assert.deepStrictEqual(fistSurfaceHit({ x: ARENA_WIDTH + 3, y: 300, z: 30 }), { x: ARENA_WIDTH - STONE_FISTS.radius, y: 300, z: 30 });
      assert.deepStrictEqual(fistSurfaceHit({ x: 400, y: -1, z: 30 }), { x: 400, y: STONE_FISTS.radius, z: 30 });
      assert.deepStrictEqual(fistSurfaceHit({ x: 400, y: 300, z: -2 }), { x: 400, y: 300, z: STONE_FISTS.radius });
    });

    it("strikes the closest living body it touches, never the caster's", () => {
      const at = { x: 200, y: 300, z: 20 };
      const players: [string, { x: number; y: number; z: number; hp: number }][] = [
        ["caster", { x: 200, y: 300, z: 0, hp: MAX_HP }],
        ["dead", { x: 200, y: 300, z: 0, hp: 0 }],
        ["grazed", { x: 200, y: 300 + 12 + 6, z: 0, hp: MAX_HP }],
        ["centred", { x: 205, y: 300, z: 0, hp: MAX_HP }],
      ];
      assert.strictEqual(fistStruck("caster", at, players), "centred");
      assert.strictEqual(fistStruck("caster", at, players.slice(0, 3)), "grazed");
      assert.strictEqual(fistStruck("caster", at, players.slice(0, 2)), undefined);
    });
  });

  describe("server skill", () => {
    it("only earth mages with Stone Fists in their kit, alive, may punch", () => {
      const { skill, join, client, punches } = fakeRoom();
      join("fire", 100, 100, "fire");
      join("water", 100, 150, "water");
      join("dead", 100, 200).hp = 0;
      for (const id of ["fire", "water", "dead", "nobody"]) { skill.cast(client(id), AIM); }
      assert.strictEqual(punches.length, 0);
    });

    it("drops junk payloads silently, punching nothing", () => {
      const { skill, join, client, punches } = fakeRoom();
      join("caster", 100, 300);
      for (const junk of [undefined, null, 5, "x", {}, { pitch: 1 }, { yaw: "1" }, { yaw: NaN }, { yaw: Infinity }]) {
        assert.doesNotThrow(() => skill.cast(client("caster"), junk));
      }
      assert.strictEqual(punches.length, 0);
      skill.cast(client("caster"), AIM);
      assert.strictEqual(punches.length, 1, "a junk click spends no time either");
    });

    it("punches on the first click, right then left then right, from that side's hand", () => {
      const { skill, join, client, wait, punches } = fakeRoom();
      join("caster", 100, 300);
      for (let i = 0; i < 3; i++) {
        skill.cast(client("caster"), AIM);
        wait(STONE_FISTS.punchIntervalMs);
      }
      assert.deepStrictEqual(punches.map((p) => p.side), ["right", "left", "right"]);
      assert.deepStrictEqual(punches.map((p) => p.id), [1, 2, 3]);
      assert.deepStrictEqual(punches[0], {
        id: 1, casterId: "caster", side: "right", cooldownMs: STONE_FISTS.punchIntervalMs, ...launchFist({ x: 100, y: 300, z: 0 }, AIM, "right"),
      });
      assert.deepStrictEqual(punches[1], {
        id: 2, casterId: "caster", side: "left", cooldownMs: STONE_FISTS.punchIntervalMs, ...launchFist({ x: 100, y: 300, z: 0 }, AIM, "left"),
      });
    });

    it("keeps punches 400 ms apart; an early click neither punches nor swaps hands", () => {
      const { skill, join, client, wait, punches } = fakeRoom();
      join("caster", 100, 300);
      skill.cast(client("caster"), AIM);
      wait(STONE_FISTS.punchIntervalMs - 1);
      skill.cast(client("caster"), AIM);
      assert.strictEqual(punches.length, 1, "too soon after the last");
      wait(1);
      skill.cast(client("caster"), AIM);
      assert.strictEqual(punches.length, 2);
      assert.strictEqual(punches[1].side, "left", "the refused click didn't use up the left hand");
    });

    it("counts each caster's hands and wait apart", () => {
      const { skill, join, client, punches } = fakeRoom();
      join("a", 100, 200);
      join("b", 100, 400);
      skill.cast(client("a"), AIM);
      skill.cast(client("b"), AIM);
      assert.deepStrictEqual(punches.map((p) => [p.casterId, p.side]), [["a", "right"], ["b", "right"]]);
    });

    it("strikes the first living enemy in its path, alone, for 6 damage", () => {
      const { skill, join, client, fly, hits, breaks } = fakeRoom();
      join("caster", 100, 300);
      join("corpse", 160, 314).hp = 0;
      join("first", 220, 314);
      join("behind", 270, 314);

      skill.cast(client("caster"), AIM);
      fly(0.5);

      assert.deepStrictEqual(hits, [{ sessionId: "first", amount: 6, source: { id: "caster", name: "caster", ability: "stones" } }]);
      assert.strictEqual(breaks.length, 1);
      assert.strictEqual(breaks[0].id, 1);
      assert.strictEqual(breaks[0].hitId, "first");
      // Punched straight at the body: it breaks against its front.
      assert.ok(breaks[0].x > 220 - 12 - 2 * STONE_FISTS.radius && breaks[0].x < 220, "breaks at the body's front");
    });

    it("never strikes the caster it is punched away from", () => {
      const { skill, join, client, fly, hits, breaks } = fakeRoom();
      join("caster", 400, 100);
      skill.cast(client("caster"), { yaw: 0 });
      fly(0.5);
      assert.strictEqual(hits.length, 0);
      assert.strictEqual(breaks.length, 1);
      assert.strictEqual(breaks[0].y, STONE_FISTS.radius, "on the arena wall ahead of them");
    });

    it("breaks on an arena wall in reach with no one in the way, hurting no one", () => {
      const { skill, join, client, fly, hits, breaks } = fakeRoom();
      join("caster", 600, 300);
      join("aside", 700, 450);
      skill.cast(client("caster"), AIM);
      fly(0.5);
      assert.strictEqual(hits.length, 0);
      assert.strictEqual(breaks.length, 1);
      assert.strictEqual(breaks[0].x, ARENA_WIDTH - STONE_FISTS.radius);
      assert.ok(!("hitId" in breaks[0]), "a miss says nothing about a target");
    });

    it("crumbles quietly at the end of its reach, short of anyone further", () => {
      const { skill, join, client, fly, hits, breaks } = fakeRoom();
      join("caster", 100, 300);
      join("far", 100 + STONE_FISTS.handAhead + STONE_FISTS.speed * (STONE_FISTS.lifetimeMs / 1000) + 40, 314);
      skill.cast(client("caster"), AIM);
      fly(1);
      assert.strictEqual(hits.length, 0);
      assert.strictEqual(breaks.length, 0, "nothing is said for a fist that crumbles in the air");
    });

    it("stops on a raised wall, sparing whoever stands behind it", () => {
      const { state, skill, join, client, fly, hits, breaks } = fakeRoom();
      join("caster", 100, 300);
      join("sheltered", 300, 314);
      state.walls.set("1", new Wall({ ownerId: "someone", kind: "wall", x: 200, y: 300, angle: Math.PI / 2, halfLength: 60, halfThickness: 6, height: 80 }));
      skill.cast(client("caster"), AIM);
      fly(0.5);
      assert.strictEqual(hits.length, 0);
      assert.strictEqual(breaks.length, 1);
      assert.ok(Math.abs(breaks[0].x - (200 - 6 - STONE_FISTS.radius)) <= STONE_FISTS.radius, "breaks on the wall's face");
      assert.strictEqual(breaks[0].hitId, undefined);
    });

    it("strikes whoever the caster saw in its path, though they have since stepped aside", () => {
      const { skill, join, client, fly, sawAgo, hits, breaks } = fakeRoom();
      join("caster", 100, 300);
      const target = join("target", 220, 450);
      sawAgo(150, target, { x: 220, y: 314, z: 0 });

      skill.cast(client("caster"), AIM);
      fly(0.5);

      assert.deepStrictEqual(hits.map((h) => h.sessionId), ["target"]);
      assert.strictEqual(breaks[0].hitId, "target");
      assert.ok(breaks[0].x < 220, "breaks where the caster saw the body");
    });

    it("with no lag, strikes where everyone stands now", () => {
      const { skill, join, client, fly, sawAgo, hits, breaks } = fakeRoom();
      join("caster", 100, 300);
      const target = join("target", 220, 314);
      sawAgo(0, target, { x: 220, y: 450, z: 0 });

      skill.cast(client("caster"), AIM);
      fly(0.5);

      assert.deepStrictEqual(hits.map((h) => h.sessionId), ["target"]);
      assert.strictEqual(breaks[0].hitId, "target");
    });

    it("a fresh round: fists in the air vanish, and everyone punches right first, right away", () => {
      const { skill, join, client, fly, punches, breaks } = fakeRoom();
      join("caster", 100, 300);
      join("target", 220, 314);
      skill.cast(client("caster"), AIM);
      skill.reset();
      fly(0.5);
      assert.strictEqual(breaks.length, 0, "the fist in the air is gone");

      skill.cast(client("caster"), AIM);
      skill.reset();
      skill.cast(client("caster"), AIM);
      assert.deepStrictEqual(punches.map((p) => p.side), ["right", "right", "right"]);
    });

    it("a caster leaving: their fist in the air still lands, their hands start over", () => {
      const { skill, join, client, fly, hits, punches } = fakeRoom();
      join("caster", 100, 300);
      join("target", 220, 314);
      skill.cast(client("caster"), AIM);
      skill.remove("caster");
      fly(0.5);
      assert.strictEqual(hits.length, 1);
      skill.cast(client("caster"), AIM);
      assert.deepStrictEqual(punches.map((p) => p.side), ["right", "right"], "rejoined: right first, no wait");
    });
  });
});
