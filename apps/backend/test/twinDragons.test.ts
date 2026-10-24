import assert from "assert";
import type { Client, Clock } from "colyseus";

import { MyRoomState, Player } from "../src/rooms/schema/MyRoomState.js";
import { MAX_HP, TICK_RATE } from "../src/shared/constants.js";
import { SERVER_MESSAGE } from "../src/shared/messages.js";
import type { DamageSource } from "../src/shared/combat.js";
import { LIVE, type SeenPoint, type SkillRoom } from "../src/skills/skillRoom.js";
import { TwinDragonsSkill } from "../src/skills/twinDragons/twinDragons.js";
import { TWIN_DRAGONS, type TwinDragonsBlast } from "../src/skills/twinDragons/twinDragonsConfig.js";

const DT = 1 / TICK_RATE;

/** A room stand-in: real state, a clock the test moves by hand, and every hit and blast, recorded. */
function fakeRoom() {
  const state = new MyRoomState();
  const clock = { currentTime: 0 } as Clock;
  const hits: { sessionId: string; amount: number; source?: DamageSource }[] = [];
  const blasts: TwinDragonsBlast[] = [];
  /** What `lagOf` says of every caster, and where `seenAgo` has players stood any time ago but now. */
  let lag = 0;
  const past = new Map<Player, SeenPoint>();
  const room: SkillRoom = {
    state,
    clock,
    broadcast(type, message) {
      if (type === SERVER_MESSAGE.twinDragonsBlast) { blasts.push(message as TwinDragonsBlast); }
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
  const skill = new TwinDragonsSkill(room);
  const join = (sessionId: string, x: number, y: number, element = "fire") => {
    const player = new Player({ name: sessionId, hp: MAX_HP, element, x, y, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, dashVx: 0, dashVy: 0, dashTime: 0, flightZ: 0, breathing: false, ready: false, wins: 0, ownerId: "" });
    state.players.set(sessionId, player);
    return player;
  };
  const client = (sessionId: string) => ({ sessionId, send() {} }) as unknown as Client;
  /** Steps the skill like the room does, a tick at a time, moving the clock along. */
  const fly = (seconds: number) => {
    for (let t = 0; t < seconds; t += DT) {
      clock.currentTime += DT * 1000;
      skill.step(DT);
    }
  };
  /** Casters see everyone `lagMs` behind, when `player` stood `at`. */
  const sawAgo = (lagMs: number, player: Player, at: SeenPoint) => { lag = lagMs; past.set(player, at); };
  return { skill, join, client, fly, sawAgo, hits, blasts };
}

describe("twinDragons (Twin Dragons)", () => {
  // Cast from (100, 300) at (300, 300): the streams bow out at most ~45 either side of
  // the line, so (300, 450) is clear of both and of the blast.
  const TARGET = { x: 300, y: 300 };

  it("blasts whoever the caster saw at the meeting point, though they have since stepped away", () => {
    const { skill, join, client, fly, sawAgo, hits, blasts } = fakeRoom();
    join("caster", 100, 300);
    const target = join("target", 300, 450);
    sawAgo(150, target, { x: 300, y: 300, z: 0 });

    skill.cast(client("caster"), TARGET);
    fly(TWIN_DRAGONS.travelMs / 1000 + 0.1);

    assert.deepStrictEqual(blasts.map((b) => b.hits), [["target"]]);
    assert.ok(hits.some((h) => h.sessionId === "target" && h.amount === TWIN_DRAGONS.damage));
  });

  it("with no lag, strikes where everyone stands now", () => {
    const { skill, join, client, fly, sawAgo, hits, blasts } = fakeRoom();
    join("caster", 100, 300);
    const moved = join("moved", 300, 450);
    const stayed = join("stayed", 300, 300);
    sawAgo(0, moved, { x: 300, y: 300, z: 0 });
    sawAgo(0, stayed, { x: 300, y: 450, z: 0 });

    skill.cast(client("caster"), TARGET);
    fly(TWIN_DRAGONS.travelMs / 1000 + 0.1);

    assert.deepStrictEqual(blasts.map((b) => b.hits), [["stayed"]]);
    assert.ok(hits.every((h) => h.sessionId === "stayed"));
  });
});
