import assert from "assert";
import type { Client, Clock } from "colyseus";

import { MyRoomState, Player } from "../src/rooms/schema/MyRoomState.js";
import { MAX_HP, TICK_RATE } from "../src/shared/constants.js";
import { SERVER_MESSAGE } from "../src/shared/messages.js";
import type { DamageSource } from "../src/shared/combat.js";
import { LIVE, type SeenAt, type SkillRoom } from "../src/skills/skillRoom.js";
import { BouldersSkill } from "../src/skills/boulders/boulders.js";
import { BOULDERS, type BoulderHit } from "../src/skills/boulders/bouldersConfig.js";

/** Aims along +x (at yaw 0 forward is -y; turning a quarter right faces +x). */
const EAST = -Math.PI / 2;
const DT = 1 / TICK_RATE;
const AIM = { yaw: EAST };

/**
 * A room stand-in: real state, a clock the test moves by hand, and everything
 * the skill does, recorded. `lag` is every kicker's `lagOf`; `rewound` is
 * where `seenAgo` has everyone for any lag above 0.
 */
function fakeRoom() {
  const state = new MyRoomState();
  // Boulders never crumble here: these tests kick them long before they would.
  const clock = { currentTime: 0, setTimeout: () => ({ clear() {} }) } as unknown as Clock;
  const hits: { sessionId: string; amount: number; source?: DamageSource }[] = [];
  const breaks: BoulderHit[] = [];
  const view: { lag: number; rewound: SeenAt; asked: number[] } = { lag: 0, rewound: LIVE, asked: [] };
  const room: SkillRoom = {
    state,
    clock,
    broadcast(type, message) {
      if (type === SERVER_MESSAGE.boulderHit) { breaks.push(message as BoulderHit); }
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
    lagOf: () => view.lag,
    seenAgo: (lagMs) => {
      view.asked.push(lagMs);
      return lagMs > 0 ? view.rewound : LIVE;
    },
  };
  const skill = new BouldersSkill(room);
  const join = (sessionId: string, x: number, y: number, element = "earth") => {
    const player = new Player({ name: sessionId, hp: MAX_HP, element, x, y, z: 0, vx: 0, vy: 0, vz: 0, yaw: EAST, dashVx: 0, dashVy: 0, dashTime: 0, flightZ: 0, breathing: false, ready: false, wins: 0, ownerId: "" });
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
  return { state, skill, join, client, fly, view, hits, breaks };
}

describe("boulders", () => {
  describe("lag compensation", () => {
    it("strikes a target where the kicker saw it, though it has since moved off the line", () => {
      const { skill, join, client, fly, view, hits, breaks } = fakeRoom();
      join("caster", 100, 300);
      const target = join("target", 300, 500);
      view.lag = 200;
      view.rewound = (player) => (player === target ? { x: 300, y: 300, z: 0 } : player);

      skill.raise(client("caster"));
      skill.kick(client("caster"), AIM);
      view.lag = 0; // Whatever the kicker's lag is later, the boulder keeps the one it was kicked with.
      fly(0.5);

      assert.deepStrictEqual(hits, [{ sessionId: "target", amount: BOULDERS.damage, source: { id: "caster", name: "caster", ability: "boulders" } }]);
      assert.strictEqual(breaks.length, 1);
      assert.strictEqual(breaks[0].hitId, "target");
      assert.ok(view.asked.length > 0 && view.asked.every((lag) => lag === 200), "every hit test read the world 200 ms back");
      assert.strictEqual(target.y, 500, "only the read is rewound: the target stays where it is");
    });

    it("with no lag, strikes where everyone is now", () => {
      const { skill, join, client, fly, view, hits, breaks } = fakeRoom();
      join("caster", 100, 300);
      const target = join("target", 300, 300);
      view.rewound = (player) => (player === target ? { x: 300, y: 500, z: 0 } : player);

      skill.raise(client("caster"));
      skill.kick(client("caster"), AIM);
      fly(0.5);

      assert.deepStrictEqual(hits.map((h) => h.sessionId), ["target"]);
      assert.strictEqual(breaks[0].hitId, "target");
      assert.ok(view.asked.every((lag) => lag === 0));
    });
  });
});
