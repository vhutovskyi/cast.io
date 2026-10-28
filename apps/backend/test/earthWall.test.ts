import assert from "assert";
import type { Client, Clock } from "colyseus";

import { MyRoomState, Player, Wall } from "../src/rooms/schema/MyRoomState.js";
import { MAX_HP } from "../src/shared/constants.js";
import { SERVER_MESSAGE } from "../src/shared/messages.js";
import type { DamageSource } from "../src/shared/combat.js";
import { LIVE, type SeenAt, type SeenPoint, type SkillRoom } from "../src/skills/skillRoom.js";
import { EarthWallSkill } from "../src/skills/earthWall/earthWall.js";
import { EARTH_WALL, distanceToWall, placeEarthWall, type EarthWallBlast } from "../src/skills/earthWall/earthWallConfig.js";

/** A room stand-in: real state, a clock the test moves by hand, and everything the skill does, recorded. */
function fakeRoom() {
  const state = new MyRoomState();
  const clock = {
    currentTime: 0,
    setTimeout: () => ({ clear() {} }),
  } as unknown as Clock;
  const hits: { sessionId: string; amount: number; source?: DamageSource }[] = [];
  const blasts: EarthWallBlast[] = [];
  /** Where `seenBy` has players stood as the caster saw them; LIVE unless a test says otherwise. */
  let seen: SeenAt = LIVE;
  const room: SkillRoom = {
    state,
    clock,
    broadcast(type, message) {
      if (type === SERVER_MESSAGE.earthWallBlast) { blasts.push(message as EarthWallBlast); }
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
    seenBy: () => seen,
    lagOf: () => 0,
    canAct: (sessionId: string) => (state.players.get(sessionId)?.hp ?? 0) > 0,
    seenAgo: () => LIVE,
  };
  const skill = new EarthWallSkill(room);
  const join = (sessionId: string, x: number, y: number, element = "earth") => {
    const player = new Player({ name: sessionId, hp: MAX_HP, element, x, y, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, dashVx: 0, dashVy: 0, dashTime: 0, flightZ: 0, breathing: false, ready: false, wins: 0, ownerId: "" });
    state.players.set(sessionId, player);
    return player;
  };
  const client = (sessionId: string) => ({ sessionId, send() {} }) as unknown as Client;
  const wait = (ms: number) => { clock.currentTime += ms; };
  /** The caster saw `player` standing `at`. */
  const saw = (player: Player, at: SeenPoint) => { seen = (p) => (p === player ? at : p); };
  return { state, skill, join, client, wait, saw, hits, blasts };
}

describe("earthWall (lag compensation)", () => {
  /**
   * Stands the caster's wall 200 east of them (across the line, so along y)
   * as `cast` does, and waits until it can blow. Earth Wall is out of every
   * kit for now, so `cast` itself turns the caster away; the wall goes in by hand.
   */
  function raised() {
    const room = fakeRoom();
    const casterPlayer = room.join("caster", 100, 300);
    const caster = room.client("caster");
    const shape = placeEarthWall(casterPlayer, { x: 300, y: 300 }, casterPlayer.yaw);
    room.state.walls.set("earth-1", new Wall({ ownerId: "caster", kind: "wall", ...shape }));
    (room.skill as unknown as { standing: Map<string, unknown> }).standing.set("caster", {
      id: "earth-1",
      detonateAt: EARTH_WALL.detonateDelayMs,
      crumble: { clear() {} },
      source: { id: "caster", name: "caster", ability: "earth_wall" },
    });
    room.wait(EARTH_WALL.detonateDelayMs);
    return { ...room, caster, wall: shape };
  }

  it("still blasts an enemy the caster saw beside the wall, though they have since walked off", () => {
    const { join, saw, skill, caster, wall, hits, blasts } = raised();
    const enemy = join("enemy", 600, 300);
    const beside = { x: 310, y: 300, z: 0 };
    assert.ok(distanceToWall(wall, enemy) > EARTH_WALL.blastRadius, "out of the blast now");
    assert.ok(distanceToWall(wall, beside) <= EARTH_WALL.blastRadius, "in it as the caster saw them");
    saw(enemy, beside);

    skill.detonate(caster);
    assert.deepStrictEqual(hits.map((h) => h.sessionId), ["enemy"]);
    assert.strictEqual(hits[0].amount, EARTH_WALL.blastDamage);
    assert.deepStrictEqual(blasts[0].hits, ["enemy"]);
  });

  it("with no lag, where everyone stands now decides", () => {
    const { join, skill, caster, wall, hits, blasts } = raised();
    join("near", 310, 300);
    join("far", 600, 300);
    assert.ok(distanceToWall(wall, { x: 310, y: 300 }) <= EARTH_WALL.blastRadius);

    skill.detonate(caster);
    assert.deepStrictEqual(hits.map((h) => h.sessionId), ["near"]);
    assert.deepStrictEqual(blasts[0].hits, ["near"]);
  });
});
