import assert from "assert";
import type { Client, Clock } from "colyseus";

import { MyRoomState, Player } from "../src/rooms/schema/MyRoomState.js";
import { MAX_HP, TICK_RATE } from "../src/shared/constants.js";
import { SERVER_MESSAGE } from "../src/shared/messages.js";
import type { DamageSource } from "../src/shared/combat.js";
import { LIVE, type SeenAt, type SkillRoom } from "../src/skills/skillRoom.js";
import { FireballSkill } from "../src/skills/fireball/fireball.js";
import { FIREBALL, type FireballHit } from "../src/skills/fireball/fireballConfig.js";

/** Aims level along +x (at yaw 0 forward is -y; turning a quarter right faces +x). */
const EAST = { yaw: -Math.PI / 2, pitch: 0 };
const DT = 1 / TICK_RATE;

/**
 * A room stand-in: real state, a clock the test moves by hand, and everything
 * the skill does, recorded. `lag` is how far behind the thrower sees everyone;
 * any lag rewinds them to `seenThen`, none leaves them live.
 */
function fakeRoom(seenThen: SeenAt) {
  const state = new MyRoomState();
  const clock = { currentTime: 0 } as Clock;
  const hits: { sessionId: string; amount: number; source?: DamageSource }[] = [];
  const blasts: FireballHit[] = [];
  const view = { lag: 0 };
  const room: SkillRoom = {
    state,
    clock,
    broadcast(type, message) {
      if (type === SERVER_MESSAGE.fireballHit) { blasts.push(message as FireballHit); }
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
    seenAgo: (lag) => lag > 0 ? seenThen : LIVE,
  };
  const skill = new FireballSkill(room);
  const join = (sessionId: string, x: number, y: number, element = "fire") => {
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
  return { skill, join, client, fly, view, hits, blasts };
}

describe("fireball", () => {
  describe("lag compensation", () => {
    // Thrown level along +x from (100, 300): the ball flies down y = 310 (the right hand).
    const onScreen = { x: 250, y: 310, z: 0 };

    it("strikes a target where the thrower saw it, though it has since moved away", () => {
      let target: Player | undefined;
      const { skill, join, client, fly, view, hits, blasts } = fakeRoom((p) => p === target ? onScreen : p);
      join("caster", 100, 300);
      target = join("target", 250, 500);

      view.lag = 150;
      skill.cast(client("caster"), EAST);
      view.lag = 0; // the lag is the thrower's at launch, kept for the whole flight
      fly(0.5);

      assert.deepStrictEqual(hits, [{ sessionId: "target", amount: FIREBALL.damage, source: { id: "caster", name: "caster", ability: "fireball" } }]);
      assert.strictEqual(target.hp, MAX_HP - FIREBALL.damage, "the damage lands on the live player");
      assert.strictEqual(target.y, 500, "only where it is read from is rewound");
      assert.strictEqual(blasts.length, 1);
      assert.ok(blasts[0].x > onScreen.x - 40 && blasts[0].x < onScreen.x, "bursts on the body as the thrower saw it");
    });

    it("with no lag, strikes where everyone stands now", () => {
      let target: Player | undefined;
      const { skill, join, client, fly, hits, blasts } = fakeRoom((p) => p === target ? { x: 250, y: 500, z: 0 } : p);
      join("caster", 100, 300);
      target = join("target", onScreen.x, onScreen.y);

      skill.cast(client("caster"), EAST);
      fly(0.5);

      assert.deepStrictEqual(hits.map((h) => h.sessionId), ["target"]);
      assert.strictEqual(blasts.length, 1);
      assert.ok(blasts[0].x > onScreen.x - 40 && blasts[0].x < onScreen.x, "bursts on the live body");
    });
  });
});
