import assert from "assert";
import type { Client, Clock } from "colyseus";
import { LIVE, type SeenPoint } from "../src/skills/skillRoom.js";

import { MyRoomState, Player } from "../src/rooms/schema/MyRoomState.js";
import { EYE_HEIGHT, MAX_HP, PLAYER_HALF } from "../src/shared/constants.js";
import type { DamageSource } from "../src/shared/combat.js";
import { SERVER_MESSAGE } from "../src/shared/messages.js";
import { canCast, moveLimits, EFFECTS, type EffectId } from "../src/effects/effectConfig.js";
import { stepEntity } from "../src/shared/movement.js";
import { FreezingStreamSkill } from "../src/skills/freezingStream/freezingStream.js";
import {
  FREEZING_STREAM, FREEZING_STREAM_TRAVEL_MS, freezingStreamPosition, freezingStreamReach, freezingStreamSurfaceStop,
  launchFreezingStream, sweepFreezingStream, type FreezingStreamCast, type FreezingStreamHit,
} from "../src/skills/freezingStream/freezingStreamConfig.js";

/** One server tick, in seconds. */
const DT = 1 / 30;

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
  /** What `lagOf` says of every caster, what `seenAgo` was last asked for, and where it has players stood any time ago but now. */
  const lag = { ms: 0, askedAgo: [] as number[] };
  const past = new Map<Player, SeenPoint>();
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
    lagOf: () => lag.ms,
    seenAgo: (lagMs: number) => {
      lag.askedAgo.push(lagMs);
      return lagMs > 0 ? (player: Player) => past.get(player) ?? player : LIVE;
    },
  };
  const skill = new FreezingStreamSkill(room);
  const join = (sessionId: string, x: number, y: number, element = "water") => {
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
  const casts = () => sent.filter((m) => m.type === SERVER_MESSAGE.freezingStreamCast).map((m) => m.message as FreezingStreamCast);
  const stops = () => sent.filter((m) => m.type === SERVER_MESSAGE.freezingStreamHit).map((m) => m.message as FreezingStreamHit);
  return { room, skill, join, client, run, casts, stops, hits, applied, clock, lag, past };
}

/** Straight ahead at yaw 0 is -y; level aim. */
const AHEAD = { yaw: 0, pitch: 0 };

describe("freezing stream", () => {
  describe("shared rules", () => {
    it("launches from the right hand at eye height, along the view, as a unit direction", () => {
      const launch = launchFreezingStream({ x: 400, y: 300, z: 0 }, AHEAD);
      assert.strictEqual(launch.x, 400 + FREEZING_STREAM.handOffset);
      assert.strictEqual(launch.y, 300);
      assert.strictEqual(launch.z, EYE_HEIGHT);
      assert.ok(Math.abs(launch.dx) < 1e-9 && Math.abs(launch.dy + 1) < 1e-9 && Math.abs(launch.dz) < 1e-9);

      const tilted = launchFreezingStream({ x: 400, y: 300, z: 0 }, { yaw: 1, pitch: 10 });
      assert.ok(Math.abs(Math.hypot(tilted.dx, tilted.dy, tilted.dz) - 1) < 1e-9);
      assert.ok(tilted.dz < 1, "pitch is clamped short of straight up");
    });

    it("moves the head in a straight line, and stops it against walls and the floor", () => {
      const launch = launchFreezingStream({ x: 400, y: 300, z: 0 }, AHEAD);
      assert.deepStrictEqual(freezingStreamPosition(launch, 100), { x: launch.x, y: 200, z: EYE_HEIGHT });
      assert.strictEqual(freezingStreamSurfaceStop({ x: 400, y: 300, z: 20 }), null);
      assert.deepStrictEqual(freezingStreamSurfaceStop({ x: 400, y: 2, z: 20 }), { x: 400, y: FREEZING_STREAM.radius, z: 20 });
      assert.deepStrictEqual(freezingStreamSurfaceStop({ x: 400, y: 300, z: -5 }), { x: 400, y: 300, z: FREEZING_STREAM.radius });
    });

    it("reaches its full range in open space, and no further", () => {
      const launch = launchFreezingStream({ x: 100, y: 300, z: 0 }, { yaw: -Math.PI / 2, pitch: 0 }); // toward +x
      const reach = freezingStreamReach(launch);
      assert.strictEqual(reach.distance, FREEZING_STREAM.range);
      assert.strictEqual(reach.hitId, undefined);
      assert.strictEqual(sweepFreezingStream(launch, 0, 100, "", []), null, "short of its range it flies on");
      assert.strictEqual(FREEZING_STREAM_TRAVEL_MS, (FREEZING_STREAM.range / FREEZING_STREAM.speed) * 1000);
    });

    it("stops short at a wall or the floor", () => {
      const toWall = freezingStreamReach(launchFreezingStream({ x: 400, y: 100, z: 0 }, AHEAD));
      assert.ok(toWall.distance < 100);
      assert.strictEqual(toWall.at.y, FREEZING_STREAM.radius);

      const down = freezingStreamReach(launchFreezingStream({ x: 400, y: 300, z: 0 }, { yaw: 0, pitch: -1 }));
      assert.ok(down.distance < FREEZING_STREAM.range);
      assert.strictEqual(down.at.z, FREEZING_STREAM.radius);
    });

    it("strikes the first living body other than the caster's along its line", () => {
      const launch = launchFreezingStream({ x: 400, y: 500, z: 0 }, AHEAD);
      const body = (x: number, y: number, hp = MAX_HP) => ({ x, y, z: 0, hp });
      const stop = sweepFreezingStream(launch, 0, FREEZING_STREAM.range, "me", [
        ["me", body(400, 500)],
        ["dead", body(launch.x, 450, 0)],
        ["far", body(launch.x, 200)],
        ["near", body(launch.x, 300)],
        ["aside", body(launch.x + 100, 400)],
      ]);
      assert.strictEqual(stop?.hitId, "near");
      assert.ok(Math.abs(stop.at.y - (300 + PLAYER_HALF + FREEZING_STREAM.radius)) <= FREEZING_STREAM.radius);
    });

    it("passes over a body below its line", () => {
      const launch = launchFreezingStream({ x: 400, y: 500, z: 200 }, AHEAD);
      const stop = sweepFreezingStream(launch, 0, FREEZING_STREAM.range, "me", [["low", { x: launch.x, y: 300, z: 0, hp: MAX_HP }]]);
      assert.strictEqual(stop?.hitId, undefined);
    });
  });

  describe("frozen", () => {
    it("can't walk, jump or cast", () => {
      assert.strictEqual(EFFECTS.frozen.durationMs, FREEZING_STREAM.freezeMs);
      assert.deepStrictEqual(moveLimits(["frozen"]), { speedScale: 0, canJump: false });
      assert.strictEqual(canCast(["frozen"]), false);
      assert.strictEqual(canCast([]), true);
    });

    it("keeps a frozen player in place, whatever they press", () => {
      const entity = { x: 400, y: 300, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, dashVx: 0, dashVy: 0, dashTime: 0, flightZ: 0 };
      for (let i = 0; i < 30; i++) {
        stepEntity(entity, { moveX: 1, moveY: -1, yaw: 0, jump: true, breath: false }, DT, moveLimits(["frozen"]));
      }
      assert.strictEqual(entity.x, 400);
      assert.strictEqual(entity.y, 300);
      assert.strictEqual(entity.z, 0);
    });
  });

  describe("server skill", () => {
    it("fires for a water mage and tells everyone the launch", () => {
      const { skill, join, client, casts } = fakeRoom();
      join("caster", 400, 500);

      skill.cast(client("caster"), AHEAD);
      const [cast] = casts();
      assert.ok(cast);
      assert.strictEqual(cast.casterId, "caster");
      assert.strictEqual(cast.cooldownMs, FREEZING_STREAM.cooldownMs);
      assert.deepStrictEqual({ ...cast, id: 0, casterId: "", cooldownMs: 0 }, {
        ...launchFreezingStream({ x: 400, y: 500, z: 0 }, AHEAD), id: 0, casterId: "", cooldownMs: 0,
      });
    });

    it("drops casts from other elements, the dead, strangers and junk", () => {
      const { skill, join, client, casts } = fakeRoom();
      join("fire", 400, 500, "fire");
      join("dead", 400, 500).hp = 0;
      join("caster", 400, 500);

      skill.cast(client("fire"), AHEAD);
      skill.cast(client("dead"), AHEAD);
      skill.cast(client("nobody"), AHEAD);
      for (const junk of [undefined, null, 5, "x", {}, { yaw: 0 }, { yaw: "0", pitch: 0 }, { yaw: NaN, pitch: 0 }, { yaw: 0, pitch: Infinity }]) {
        skill.cast(client("caster"), junk);
      }
      assert.strictEqual(casts().length, 0);
    });

    it("refuses a second cast until the cooldown is over", () => {
      const { skill, join, client, casts, clock } = fakeRoom();
      join("caster", 400, 500);

      skill.cast(client("caster"), AHEAD);
      clock.currentTime = FREEZING_STREAM.cooldownMs - 1;
      skill.cast(client("caster"), AHEAD);
      assert.strictEqual(casts().length, 1);
      clock.currentTime = FREEZING_STREAM.cooldownMs;
      skill.cast(client("caster"), AHEAD);
      assert.strictEqual(casts().length, 2);
    });

    it("travels over time, then strikes and freezes the first enemy only", () => {
      const { skill, join, client, run, stops, hits, applied } = fakeRoom();
      join("caster", 400, 500);
      const near = join("near", 410, 250);
      join("behind", 410, 150);

      skill.cast(client("caster"), AHEAD);
      // The near body's edge is ~240 units out: not reached in the first quarter of the flight.
      run(150);
      assert.strictEqual(stops().length, 0, "the head is still on its way");
      assert.strictEqual(hits.length, 0);

      run(300);
      const [stop] = stops();
      assert.strictEqual(stop?.hitId, "near");
      assert.ok(stop.distance > 200 && stop.distance < 260);
      assert.deepStrictEqual(hits.map((h) => [h.sessionId, h.amount, h.source?.ability]), [["near", FREEZING_STREAM.damage, "freezing_stream"]]);
      assert.deepStrictEqual(applied.map((a) => [a.sessionId, a.id, a.durationMs]), [["near", "frozen", FREEZING_STREAM.freezeMs]]);
      assert.deepStrictEqual([...near.effects], ["frozen"]);
      assert.strictEqual(near.hp, MAX_HP - FREEZING_STREAM.damage);

      run(1000);
      assert.strictEqual(stops().length, 1, "one stream, one stop");
      assert.strictEqual(hits.length, 1);
    });

    it("never strikes its caster, nor the dead", () => {
      const { skill, join, client, run, stops, hits } = fakeRoom();
      join("caster", 400, 500);
      join("corpse", 410, 300).hp = 0;

      skill.cast(client("caster"), AHEAD);
      run(1000);
      assert.strictEqual(hits.length, 0);
      assert.strictEqual(stops()[0]?.hitId, undefined);
    });

    it("runs out at its range, harmlessly", () => {
      const { skill, join, client, run, stops, hits } = fakeRoom();
      join("caster", 100, 300);
      join("outOfReach", 100 + FREEZING_STREAM.range + FREEZING_STREAM.handOffset + PLAYER_HALF + 40, 300);

      skill.cast(client("caster"), { yaw: -Math.PI / 2, pitch: 0 }); // toward +x
      run(FREEZING_STREAM_TRAVEL_MS - 100);
      assert.strictEqual(stops().length, 0);
      run(200);
      const [stop] = stops();
      assert.strictEqual(stop?.hitId, undefined);
      assert.strictEqual(stop.distance, FREEZING_STREAM.range);
      assert.strictEqual(hits.length, 0);
    });

    it("stops against a wall, sparing whoever is behind it", () => {
      const { skill, join, client, run, stops, hits } = fakeRoom();
      join("caster", 400, 80);

      skill.cast(client("caster"), AHEAD);
      run(200);
      const [stop] = stops();
      assert.strictEqual(stop?.hitId, undefined);
      assert.strictEqual(stop.y, FREEZING_STREAM.radius);
      assert.strictEqual(hits.length, 0);
    });

    it("freezes whoever the caster saw in its path, though they have since stepped aside", () => {
      const { skill, join, client, run, stops, hits, applied, lag, past } = fakeRoom();
      join("caster", 400, 500);
      // On the caster's screen the target still stands in the line; live, it is well clear of it.
      const target = join("target", 600, 250);
      past.set(target, { x: 410, y: 250, z: 0 });
      lag.ms = 150;

      skill.cast(client("caster"), AHEAD);
      run(1000);
      assert.strictEqual(stops()[0]?.hitId, "target");
      assert.ok(lag.askedAgo.length > 0 && lag.askedAgo.every((ms) => ms === 150), "every sweep reads the caster's lag at launch");
      assert.deepStrictEqual(hits.map((h) => h.sessionId), ["target"]);
      assert.deepStrictEqual(applied.map((a) => [a.sessionId, a.id]), [["target", "frozen"]]);
      assert.deepStrictEqual([...target.effects], ["frozen"], "the freeze lands on the live player");
      assert.strictEqual(target.x, 600, "only the hit test is rewound");
    });

    it("with no lag, reads everyone where they are now", () => {
      const { skill, join, client, run, stops, hits, lag, past } = fakeRoom();
      join("caster", 400, 500);
      const target = join("target", 600, 250);
      past.set(target, { x: 410, y: 250, z: 0 });

      skill.cast(client("caster"), AHEAD);
      run(1000);
      assert.ok(lag.askedAgo.length > 0 && lag.askedAgo.every((ms) => ms === 0));
      assert.strictEqual(stops()[0]?.hitId, undefined, "the live target is out of the line");
      assert.strictEqual(hits.length, 0);
    });

    it("a fresh round clears cooldowns and streams on their way; leaving clears only the cooldown", () => {
      const { skill, join, client, run, casts, stops, hits } = fakeRoom();
      join("caster", 400, 500);
      join("target", 410, 250);

      skill.cast(client("caster"), AHEAD);
      skill.reset();
      run(1000);
      assert.strictEqual(stops().length, 0, "the stream vanished with the round");
      assert.strictEqual(hits.length, 0);

      skill.cast(client("caster"), AHEAD);
      assert.strictEqual(casts().length, 2, "the cooldown went too");

      skill.remove("caster");
      skill.cast(client("caster"), AHEAD);
      assert.strictEqual(casts().length, 3, "leaving dropped the cooldown");
      run(1000);
      assert.strictEqual(stops().length, 2, "streams already on their way still land");
      assert.strictEqual(hits[0]?.sessionId, "target");
    });
  });
});
