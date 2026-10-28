import assert from "assert";
import { ColyseusTestServer, boot } from "@colyseus/testing";

import appConfig from "../src/app.config.js";
import { MyRoomState, type MoveInput, type Player } from "../src/rooms/schema/MyRoomState.js";
import { PLAYER_SPEED, TICK_RATE, GRAVITY, JUMP_SPEED, ROOM_NAME_MAX, NICKNAME_MAX, MAX_HP, PLAYER_HALF, ARENA_WIDTH, ARENA_HEIGHT, RESPAWN_DELAY_MS, EYE_HEIGHT } from "../src/shared/constants.js";
import { SUN_STRIKE, type SunStrikeCharging, type SunStrikeHit } from "../src/skills/sunStrike/sunStrikeConfig.js";
import { FIREBALL, FIREBALL_LAUNCH_SPEED, fireballLanding, fireballPosition, launchFireball, type FireballCast, type FireballHit } from "../src/skills/fireball/fireballConfig.js";
import { FLAME_BREATH, type FlameBreathEnd } from "../src/skills/flameBreath/flameBreathConfig.js";
import { EARTH_WALL, type EarthWallBlast, type EarthWallRaised } from "../src/skills/earthWall/earthWallConfig.js";
import { STONE_SKIN } from "../src/skills/stoneSkin/stoneSkinConfig.js";
import { BOULDERS, type BoulderHit, type BoulderKicked, type BoulderRaised } from "../src/skills/boulders/bouldersConfig.js";
import { ELEMENT_KITS, type ElementKit } from "../src/shared/skills.js";
import { TORRENT, type TorrentCharging, type TorrentHit } from "../src/skills/torrent/torrentConfig.js";
import { RUPTURE, RUPTURE_TRAVEL_MS } from "../src/skills/rupture/ruptureConfig.js";
import { FREEZING_STREAM } from "../src/skills/freezingStream/freezingStreamConfig.js";
import { WHIP_SHARD } from "../src/skills/waterWhip/whipShardConfig.js";
import { WATER_WHIP, whipStrike, type WaterWhipCast } from "../src/skills/waterWhip/waterWhipConfig.js";
import { TWIN_DRAGONS, twinDragonsPoint, type TwinDragonsLaunch, type TwinDragonsHeads, type TwinDragonsBlast } from "../src/skills/twinDragons/twinDragonsConfig.js";
import { CLIENT_MESSAGE, SERVER_MESSAGE } from "../src/shared/messages.js";
import type { DamageSource, KillEvent } from "../src/shared/combat.js";
import { StatusEffects } from "../src/effects/statusEffects.js";
import { MAX_REWIND_MS, sanitizeText, type MyRoom } from "../src/rooms/MyRoom.js";
import type { InputPacer } from "../src/rooms/inputPacer.js";
import { BATTLE_ROYALE, DUEL, FFA, type GameModeId } from "../src/shared/gameModes.js";
import { DEFAULT_MAP, MAPS, MAP_TERRAIN, PLAYABLE_MAPS, parseMap } from "../src/shared/maps.js";
import { INPUT_ACTION } from "../src/shared/actions.js";
import { stepEntity } from "../src/shared/movement.js";
import { blockedByWalls, canCast, moveLimits } from "../src/effects/effectConfig.js";
import { BURROW_DIG_STEPS } from "../src/skills/burrow/burrowConfig.js";
// The client's own prediction of these skills: run here exactly as its reconciler does.
import { ActionPrediction } from "../../frontend/src/net/actionPrediction.js";

describe("testing your Colyseus app", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;

  before(async () => colyseus = await boot(appConfig));
  after(async () => colyseus.shutdown());

  beforeEach(async () => {
    await colyseus.cleanup();
  });

  type TestRoom = { state: MyRoomState; waitForNextMessage(): Promise<unknown>; waitForNextTimestep(): Promise<unknown> };
  type TestClient = { sessionId: string; input<T>(options: { mode: "reliable" }): { data: T; send(): void } };

  /**
   * Two fire mages, one burn from death each, breathe at each other face to
   * face until the round is decided. Both breaths are held back until both
   * have arrived, so they run on the same step. The flames burn whoever the
   * breather saw in them, so both stand there for a whole rewind window first.
   */
  async function breatheEachOtherDown(room: TestRoom, a: TestClient, b: TestClient) {
    const arena = room as unknown as MyRoom;
    const [pa, pb] = [a, b].map((c) => room.state.players.get(c.sessionId));
    Object.assign(pa, { x: 400, y: 340, yaw: 0 });
    Object.assign(pb, { x: 400, y: 260, yaw: Math.PI });
    arena.damage(a.sessionId, MAX_HP - FLAME_BREATH.tickDamage);
    arena.damage(b.sessionId, MAX_HP - FLAME_BREATH.tickDamage);
    await new Promise((r) => setTimeout(r, MAX_REWIND_MS + 100));

    const pacer = (arena as unknown as { pacer: InputPacer }).pacer;
    const take = pacer.take.bind(pacer);
    let held = true;
    pacer.take = (sessionId, queue) => held ? [] : take(sessionId, queue);
    for (const [client, yaw] of [[a, 0], [b, Math.PI]] as const) {
      const input = client.input<MoveInput>({ mode: "reliable" });
      Object.assign(input.data, { yaw, breath: true });
      input.send();
    }
    const queued = () => [a, b].every((c) => arena.inputs.get(c.sessionId).size > 0);
    while (!queued()) { await room.waitForNextMessage(); }
    held = false;
    while (room.state.match.phase === "fighting") { await room.waitForNextTimestep(); }
  }

  it("advances a player from its buffered input", async () => {
    const room = await colyseus.createRoom<MyRoomState>("my_room", {});
    const client1 = await colyseus.connectTo(room);

    const player = room.state.players.get(client1.sessionId);
    assert.ok(player, "a Player is created on join");
    const startX = player.x;

    const input = client1.input<MoveInput>({ mode: "reliable" });
    input.data.moveX = 1;
    input.data.moveY = 0;
    input.send();

    await room.waitForNextMessage();  // the input reaches the server
    await room.waitForNextTimestep(); // the step that consumes it runs

    assert.ok(player.x > startX, "the buffered input advanced the player");
  });

  it("paces a burst of inputs instead of teleporting the player", async () => {
    const room = await colyseus.createRoom<MyRoomState>("my_room", {});
    const client1 = await colyseus.connectTo(room);
    const player = room.state.players.get(client1.sessionId);
    Object.assign(player, { x: 200, y: 300 });

    // Record how many inputs each simulation step applies for this player.
    // (A server frame may run several steps, so count per step, not per wait.)
    const pacer = (room as unknown as { pacer: InputPacer }).pacer;
    const take = pacer.take.bind(pacer);
    const perStep: number[] = [];
    pacer.take = (sessionId, queue) => {
      const taken = take(sessionId, queue);
      if (sessionId === client1.sessionId && taken.length > 0) { perStep.push(taken.length); }
      return taken;
    };

    // Six inputs arriving at once, as after a network stall.
    const input = client1.input<MoveInput>({ mode: "reliable" });
    input.data.moveX = 1;
    for (let i = 0; i < 6; i++) { input.send(); }
    await new Promise((r) => setTimeout(r, 400));

    assert.ok(perStep.length >= 3 && perStep.every((n) => n <= 2), `spread over steps, not one leap: ${perStep}`);
    const step = PLAYER_SPEED / TICK_RATE;
    assert.ok(Math.abs(player.x - (200 + 6 * step)) < 1e-6, "every input still applied, in order");
  });

  it("patches state once per simulation step", async () => {
    const room = await colyseus.createRoom<MyRoomState>("my_room", {});
    assert.strictEqual(room.patchRate, 1000 / TICK_RATE);
  });

  it("clamps input that is out of range", async () => {
    const room = await colyseus.createRoom<MyRoomState>("my_room", {});
    const client1 = await colyseus.connectTo(room);

    const player = room.state.players.get(client1.sessionId);
    const startX = player.x;

    // A modified client claiming a huge axis value: sanitize clamps it to 1.
    const input = client1.input<MoveInput>({ mode: "reliable" });
    input.data.moveX = 100 as any;
    input.send();

    await room.waitForNextMessage();
    await room.waitForNextTimestep();

    // The room steps once per received input, so one input is exactly one step
    // of travel — at moveX clamped to 1, not the 100 the client asked for.
    assert.strictEqual(player.x, startX + PLAYER_SPEED * (1 / TICK_RATE));
  });

  it("moves forward along the look direction", async () => {
    const room = await colyseus.createRoom<MyRoomState>("my_room", {});
    const client1 = await colyseus.connectTo(room);

    const player = room.state.players.get(client1.sessionId);
    const startX = player.x;
    const startY = player.y;

    // Looking a quarter turn left (yaw +π/2), "forward" is -x on the plane.
    const input = client1.input<MoveInput>({ mode: "reliable" });
    input.data.moveX = 0;
    input.data.moveY = -1;
    input.data.yaw = Math.PI / 2;
    input.send();

    await room.waitForNextMessage();
    await room.waitForNextTimestep();

    assert.ok(Math.abs(player.x - (startX - PLAYER_SPEED / TICK_RATE)) < 1e-3, "moved -x");
    assert.ok(Math.abs(player.y - startY) < 1e-3, "no sideways drift");
    assert.ok(Math.abs(player.yaw - Math.PI / 2) < 1e-6, "yaw is synced for other players");
  });

  it("lists the room under the name its creator chose", async () => {
    const room = await colyseus.createRoom<MyRoomState>("my_room", { name: "  Fire   pit  " });
    assert.strictEqual(room.metadata.name, "Fire pit");
  });

  it("sanitizes or defaults the room name", async () => {
    assert.strictEqual(sanitizeText("a\u0000b‮c\n", ROOM_NAME_MAX), "abc");
    assert.strictEqual(sanitizeText("x".repeat(100), ROOM_NAME_MAX).length, ROOM_NAME_MAX);
    assert.strictEqual(sanitizeText({ toString: () => "evil" }, ROOM_NAME_MAX), "");

    const room = await colyseus.createRoom<MyRoomState>("my_room", {});
    assert.strictEqual(room.metadata.name, `Arena ${room.roomId}`);
  });

  it("shows each player's sanitized nickname, or a default", async () => {
    const room = await colyseus.createRoom<MyRoomState>("my_room", {});
    const named = await colyseus.connectTo(room, { nickname: ` Blaze\u0007${"!".repeat(40)}` });
    const unnamed = await colyseus.connectTo(room, {});

    const name = room.state.players.get(named.sessionId).name;
    assert.ok(name.startsWith("Blaze!"), "control characters stripped");
    assert.strictEqual(name.length, NICKNAME_MAX);
    assert.strictEqual(room.state.players.get(unnamed.sessionId).name, `Mage ${unnamed.sessionId.slice(0, 4)}`);
  });

  it("spawns at full health and takes damage down to zero", async () => {
    const room = await colyseus.createRoom<MyRoomState>("my_room", {});
    const client1 = await colyseus.connectTo(room);
    const arena = room as unknown as MyRoom;

    const player = room.state.players.get(client1.sessionId);
    assert.strictEqual(player.hp, MAX_HP);

    arena.damage(client1.sessionId, 39.6);
    assert.strictEqual(player.hp, MAX_HP - 40, "whole points");

    arena.damage(client1.sessionId, -50);
    arena.damage(client1.sessionId, NaN);
    assert.strictEqual(player.hp, MAX_HP - 40, "no healing or poisoning via damage()");

    arena.damage(client1.sessionId, 1000);
    await room.waitForNextTimestep(); // deaths land at the end of the step
    assert.strictEqual(player.hp, 0, "never below zero");
  });

  it("runs every hit through the victim's status effects, which sync to clients and end at death", async () => {
    const room = await colyseus.createRoom<MyRoomState>("my_room", {});
    const client1 = await colyseus.connectTo(room);
    const arena = room as unknown as MyRoom;
    // The real registry is empty: swap in a test-only effect that a fireball hit applies.
    (arena as unknown as { effects: StatusEffects }).effects =
      new StatusEffects(arena, { marked: { durationMs: 60_000, damageTakenScale: 2 } }, { fireball: ["marked"] });
    const fireball: DamageSource = { id: "someone", name: "Someone", ability: "fireball" };
    const player = room.state.players.get(client1.sessionId);

    arena.damage(client1.sessionId, 10);
    assert.deepStrictEqual([...player.effects], [], "no source, no on-hit effects");

    arena.damage(client1.sessionId, 10, fireball);
    assert.strictEqual(player.hp, MAX_HP - 20, "the hit that applies the mark isn't scaled by it");
    assert.deepStrictEqual([...player.effects], ["marked"]);

    await room.waitForNextPatch();
    assert.deepStrictEqual([...client1.state.players.get(client1.sessionId).effects], ["marked"], "the client sees it");

    arena.damage(client1.sessionId, 10);
    assert.strictEqual(player.hp, MAX_HP - 40, "later hits are");

    arena.damage(client1.sessionId, 1000, fireball);
    await room.waitForNextTimestep(); // deaths land at the end of the step
    assert.strictEqual(player.hp, 0);
    assert.deepStrictEqual([...player.effects], [], "death clears every effect");
  });

  it("applies dev-only debug damage outside production", async () => {
    const room = await colyseus.createRoom<MyRoomState>("my_room", {});
    const client1 = await colyseus.connectTo(room);

    client1.send(CLIENT_MESSAGE.debugDamage);
    await room.waitForNextMessage();
    assert.strictEqual(room.state.players.get(client1.sessionId).hp, MAX_HP - 10);
  });

  it("joins with a playable element, defaulting to fire", async () => {
    const room = await colyseus.createRoom<MyRoomState>("my_room", {});
    const chose = await colyseus.connectTo(room, { element: "water" });
    const omitted = await colyseus.connectTo(room, {});
    const skillless = await colyseus.connectTo(room, { element: "earth" });

    assert.strictEqual(room.state.players.get(chose.sessionId).element, "water");
    assert.strictEqual(room.state.players.get(skillless.sessionId).element, "earth", "earth");
    const wind = await colyseus.connectTo(room, { element: "wind" });
    assert.strictEqual(room.state.players.get(wind.sessionId).element, "wind", "wind, with no skills");
    assert.strictEqual(room.state.players.get(omitted.sessionId).element, "fire");
  });

  it("refuses elements that don't exist", async () => {
    const room = await colyseus.createRoom<MyRoomState>("my_room", {});

    for (const element of ["lava", 42]) {
      await assert.rejects(colyseus.connectTo(room, { element } as any), `rejects ${element}`);
    }
    assert.strictEqual(room.state.players.size, 0);
  });

  describe("death and respawn", () => {
    it("a dead player can't move or jump, and inputs don't replay after respawn", async () => {
      const room = await colyseus.createRoom<MyRoomState>("my_room", {});
      const client1 = await colyseus.connectTo(room);
      const player = room.state.players.get(client1.sessionId);
      (room as unknown as MyRoom).damage(client1.sessionId, MAX_HP * 5);
      await room.waitForNextTimestep(); // deaths land at the end of the step
      assert.strictEqual(player.hp, 0, "clamped at zero");

      const { x, y } = player;
      const input = client1.input<MoveInput>({ mode: "reliable" });
      input.data.moveX = 1;
      input.data.jump = true;
      input.send();
      await room.waitForNextMessage();
      await room.waitForNextTimestep();

      assert.deepStrictEqual([player.x, player.y, player.z], [x, y, 0], "stayed put on the floor");
    });

    it("respawns at full health only when dead, and only after the delay", async () => {
      const room = await colyseus.createRoom<MyRoomState>("my_room", {});
      const client1 = await colyseus.connectTo(room);
      const player = room.state.players.get(client1.sessionId);
      const arena = room as unknown as MyRoom;

      arena.damage(client1.sessionId, 30);
      client1.send(CLIENT_MESSAGE.respawn);
      await room.waitForNextMessage();
      assert.strictEqual(player.hp, MAX_HP - 30, "alive players can't respawn to heal");

      arena.damage(client1.sessionId, MAX_HP);
      await room.waitForNextTimestep(); // deaths land at the end of the step
      const deathSpot = { x: player.x, y: player.y };
      client1.send(CLIENT_MESSAGE.respawn);
      await room.waitForNextMessage();
      assert.strictEqual(player.hp, 0, "too early: still dead");

      await new Promise((r) => setTimeout(r, RESPAWN_DELAY_MS + 200)); // room clock advances per tick
      client1.send(CLIENT_MESSAGE.respawn);
      await room.waitForNextMessage();

      assert.strictEqual(player.hp, MAX_HP);
      assert.notDeepStrictEqual({ x: player.x, y: player.y }, deathSpot, "moved to a fresh spawn point");
      assert.deepStrictEqual([player.z, player.vx, player.vy, player.vz], [0, 0, 0, 0]);
    });

    it("announces each death once, crediting the killer and the ability", async () => {
      const room = await colyseus.createRoom<MyRoomState>("my_room", {});
      const victim = await colyseus.connectTo(room, { nickname: "Torrent" });
      const caster = await colyseus.connectTo(room, { nickname: "Blaze" });
      const player = room.state.players.get(victim.sessionId);
      Object.assign(player, { x: 200, y: 200, hp: SUN_STRIKE.damage });

      const kills: KillEvent[] = [];
      caster.onMessage(SERVER_MESSAGE.kill, (kill: KillEvent) => kills.push(kill));

      caster.send(CLIENT_MESSAGE.sunStrike, { x: 200, y: 200 });
      await new Promise((r) => setTimeout(r, SUN_STRIKE.delayMs + 300));
      (room as unknown as MyRoom).damage(victim.sessionId, 10); // already dead: no second kill

      assert.strictEqual(kills.length, 1);
      assert.deepStrictEqual(kills[0], {
        victimId: victim.sessionId,
        victimName: "Torrent",
        killer: { id: caster.sessionId, name: "Blaze", ability: "sun_strike" },
      });
    });

    it("dead players can't cast Sun Strike and aren't hit by one", async () => {
      const room = await colyseus.createRoom<MyRoomState>("my_room", {});
      const ghost = await colyseus.connectTo(room);
      const caster = await colyseus.connectTo(room);
      const arena = room as unknown as MyRoom;
      Object.assign(room.state.players.get(ghost.sessionId), { x: 200, y: 200 });
      arena.damage(ghost.sessionId, MAX_HP);
      await room.waitForNextTimestep(); // deaths land at the end of the step

      let ghostCharging = 0;
      ghost.onMessage(SERVER_MESSAGE.sunStrikeCharging, () => ghostCharging++);
      ghost.send(CLIENT_MESSAGE.sunStrike, { x: 300, y: 300 });

      const hits: SunStrikeHit[] = [];
      caster.onMessage(SERVER_MESSAGE.sunStrikeHit, (hit: SunStrikeHit) => hits.push(hit));
      caster.send(CLIENT_MESSAGE.sunStrike, { x: 200, y: 200 });
      await new Promise((r) => setTimeout(r, SUN_STRIKE.delayMs + 300));

      assert.strictEqual(ghostCharging, 0, "the dead can't cast");
      assert.deepStrictEqual(hits[0].hits, [], "the dead aren't hit again");
    });
  });

  describe("Sun Strike", () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    it("charges for the caster only, then hits others in range but never the caster", async () => {
      const room = await colyseus.createRoom<MyRoomState>("my_room", {});
      const caster = await colyseus.connectTo(room);
      const near = await colyseus.connectTo(room);
      const far = await colyseus.connectTo(room);
      const player = (c: { sessionId: string }) => room.state.players.get(c.sessionId);

      // Caster stands in its own strike; `near` is just touching the edge.
      Object.assign(player(caster), { x: 400, y: 300 });
      Object.assign(player(near), { x: 400 + SUN_STRIKE.radius + PLAYER_HALF, y: 300 });
      Object.assign(player(far), { x: 100, y: 100 });

      const seen = new Map<string, string[]>();
      const hits: SunStrikeHit[] = [];
      for (const c of [caster, near, far]) {
        seen.set(c.sessionId, []);
        c.onMessage(SERVER_MESSAGE.sunStrikeCharging, () => seen.get(c.sessionId).push("charging"));
        c.onMessage(SERVER_MESSAGE.sunStrikeHit, (hit: SunStrikeHit) => { seen.get(c.sessionId).push("hit"); hits.push(hit); });
      }

      caster.send(CLIENT_MESSAGE.sunStrike, { x: 400, y: 300 });
      await sleep(300);

      assert.deepStrictEqual(seen.get(caster.sessionId), ["charging"]);
      assert.deepStrictEqual(seen.get(near.sessionId), [], "enemies get no warning");
      assert.deepStrictEqual(seen.get(far.sessionId), []);
      assert.strictEqual(player(near).hp, MAX_HP, "nothing lands before the delay");

      await sleep(SUN_STRIKE.delayMs);

      for (const c of [caster, near, far]) { assert.ok(seen.get(c.sessionId).includes("hit"), "everyone sees the hit"); }
      assert.deepStrictEqual(hits[0].hits, [near.sessionId]);
      assert.strictEqual(player(near).hp, MAX_HP - SUN_STRIKE.damage);
      assert.strictEqual(player(caster).hp, MAX_HP, "no self damage");
      assert.strictEqual(player(far).hp, MAX_HP);
    });

    it("enforces the cooldown, clamps the target, and ignores junk", async () => {
      const room = await colyseus.createRoom<MyRoomState>("my_room", {});
      const caster = await colyseus.connectTo(room);

      const charging: SunStrikeCharging[] = [];
      caster.onMessage(SERVER_MESSAGE.sunStrikeCharging, (m: SunStrikeCharging) => charging.push(m));

      for (const junk of [{}, { x: "1", y: 2 }, { x: 1 }, null, "boom"]) {
        caster.send(CLIENT_MESSAGE.sunStrike, junk as any);
      }
      caster.send(CLIENT_MESSAGE.sunStrike, { x: -1000, y: 99999 });
      caster.send(CLIENT_MESSAGE.sunStrike, { x: 10, y: 10 }); // still on cooldown
      await sleep(300);

      assert.strictEqual(charging.length, 1);
      assert.strictEqual(charging[0].x, 0);
      assert.strictEqual(charging[0].y, ARENA_HEIGHT);
      assert.strictEqual(charging[0].cooldownMs, SUN_STRIKE.cooldownMs);
    });
  });

  describe("Water Whip", () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const alive = (x: number, y: number, z = 0) => ({ x, y, z, hp: MAX_HP });

    it("strikes the nearest living body in the cone, and no one outside it", () => {
      // Facing -y at yaw 0.
      const caster = { x: 400, y: 300, z: 0 };
      const level = { yaw: 0, pitch: 0 };
      const strike = (players: [string, ReturnType<typeof alive>][]) => whipStrike("me", caster, level, players).hitId;

      assert.strictEqual(strike([["near", alive(400, 230)], ["nearer", alive(405, 250)]]), "nearer");
      assert.strictEqual(strike([["ghost", { ...alive(400, 250), hp: 0 }], ["far", alive(400, 230)]]), "far", "the dead don't block");
      assert.strictEqual(strike([["me", alive(400, 290)]]), undefined, "never the caster");
      assert.strictEqual(strike([["behind", alive(400, 350)]]), undefined);
      assert.strictEqual(strike([["aside", alive(460, 260)]]), undefined, "outside the cone");
      assert.strictEqual(strike([["edge", alive(400, 300 - WATER_WHIP.range - PLAYER_HALF + 1)]]), "edge", "reaches a body's edge");
      assert.strictEqual(strike([["beyond", alive(400, 300 - WATER_WHIP.range - PLAYER_HALF - 1)]]), undefined, "out of range");
      assert.strictEqual(strike([["above", alive(400, 230, 120)]]), undefined, "too high for a level lash");
      assert.strictEqual(whipStrike("me", caster, { yaw: 0, pitch: 0.8 }, [["above", alive(400, 230, 80)]]).hitId, "above", "aimed up at them");
    });

    it("cracks at full reach on a miss, never below the floor", () => {
      const miss = whipStrike("me", { x: 400, y: 300, z: 0 }, { yaw: 0, pitch: 0 }, []);
      assert.deepStrictEqual(miss, { end: { x: 400, y: 300 - WATER_WHIP.range, z: EYE_HEIGHT } });
      const down = whipStrike("me", { x: 400, y: 300, z: 0 }, { yaw: 0, pitch: -1.4 }, []);
      assert.strictEqual(down.end.z, 0);
    });

    it("hurts the struck player at once and tells everyone, for water mages only", async () => {
      const room = await colyseus.createRoom<MyRoomState>("my_room", {});
      const caster = await colyseus.connectTo(room, { element: "water", nickname: "Torrent" });
      const fire = await colyseus.connectTo(room, { element: "fire" });
      const victim = await colyseus.connectTo(room);
      const player = (c: { sessionId: string }) => room.state.players.get(c.sessionId);
      Object.assign(player(caster), { x: 400, y: 300, yaw: 0 });
      Object.assign(player(fire), { x: 400, y: 420, yaw: Math.PI });
      Object.assign(player(victim), { x: 400, y: 220 });

      const casts: WaterWhipCast[] = [];
      for (const c of [caster, victim]) { c.onMessage(SERVER_MESSAGE.waterWhipCast, (m: WaterWhipCast) => casts.push(m)); }
      const kills: KillEvent[] = [];
      caster.onMessage(SERVER_MESSAGE.kill, (kill: KillEvent) => kills.push(kill));

      fire.send(CLIENT_MESSAGE.waterWhip, { yaw: Math.PI, pitch: 0 }); // not in a fire mage's kit
      caster.send(CLIENT_MESSAGE.waterWhip, { yaw: 0, pitch: 0 });
      await sleep(100);

      assert.strictEqual(casts.length, 2, "everyone sees the one lash");
      assert.deepStrictEqual(casts[0], casts[1]);
      assert.strictEqual(casts[0].casterId, caster.sessionId);
      assert.strictEqual(casts[0].hitId, victim.sessionId);
      assert.strictEqual(casts[0].cooldownMs, WATER_WHIP.cooldownMs);
      assert.strictEqual(casts[0].step, 0, "the combo opens with the right hand");
      assert.strictEqual(casts[0].hand, "right");
      assert.strictEqual(player(victim).hp, MAX_HP - WATER_WHIP.damage);
      assert.strictEqual(player(caster).hp, MAX_HP, "the fire mage's lash was refused");

      player(victim).hp = WATER_WHIP.damage;
      await sleep(WATER_WHIP.cooldownMs + 100);
      caster.send(CLIENT_MESSAGE.waterWhip, { yaw: 0, pitch: 0 });
      await sleep(100);
      assert.deepStrictEqual(kills.map((k) => k.killer), [{ id: caster.sessionId, name: "Torrent", ability: "water_whip" }]);
    });

    it("enforces the cooldown and ignores junk", async () => {
      const room = await colyseus.createRoom<MyRoomState>("my_room", {});
      const caster = await colyseus.connectTo(room, { element: "water" });

      let casts = 0;
      caster.onMessage(SERVER_MESSAGE.waterWhipCast, () => casts++);
      for (const junk of [{}, { yaw: "1", pitch: 0 }, { yaw: 0 }, { yaw: NaN, pitch: 0 }, null, "lash"]) {
        caster.send(CLIENT_MESSAGE.waterWhip, junk as any);
      }
      caster.send(CLIENT_MESSAGE.waterWhip, { yaw: 0, pitch: 0 });
      caster.send(CLIENT_MESSAGE.waterWhip, { yaw: 1, pitch: 0 }); // still on cooldown
      await sleep(200);
      assert.strictEqual(casts, 1);

      await sleep(WATER_WHIP.cooldownMs); // room clock advances per tick: leave a margin
      caster.send(CLIENT_MESSAGE.waterWhip, { yaw: 1, pitch: 0 });
      await sleep(100);
      assert.strictEqual(casts, 2, "ready again after the cooldown");
    });
  });

  describe("Torrent", () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    it("bubbles for the caster only, then hurts, slows and hurls others caught in it", async () => {
      const room = await colyseus.createRoom<MyRoomState>("my_room", {});
      const caster = await colyseus.connectTo(room, { element: "water" });
      const near = await colyseus.connectTo(room);
      const far = await colyseus.connectTo(room);
      const player = (c: { sessionId: string }) => room.state.players.get(c.sessionId);

      // Caster stands in its own torrent; `near` is just touching the edge.
      Object.assign(player(caster), { x: 400, y: 300 });
      Object.assign(player(near), { x: 400 + TORRENT.radius + PLAYER_HALF, y: 300 });
      Object.assign(player(far), { x: 600, y: 300 });

      const seen = new Map<string, string[]>();
      const hits: TorrentHit[] = [];
      for (const c of [caster, near, far]) {
        seen.set(c.sessionId, []);
        c.onMessage(SERVER_MESSAGE.torrentCharging, () => seen.get(c.sessionId).push("charging"));
        c.onMessage(SERVER_MESSAGE.torrentHit, (hit: TorrentHit) => { seen.get(c.sessionId).push("hit"); hits.push(hit); });
      }

      caster.send(CLIENT_MESSAGE.torrent, { x: 400, y: 300 });
      await sleep(TORRENT.delayMs / 3);
      assert.deepStrictEqual(seen.get(caster.sessionId), ["charging"]);
      assert.deepStrictEqual(seen.get(near.sessionId), [], "enemies get no warning");
      assert.strictEqual(player(near).hp, MAX_HP, "nothing before the delay");

      await sleep(TORRENT.delayMs);
      for (const c of [caster, near, far]) { assert.ok(seen.get(c.sessionId).includes("hit"), "everyone sees it erupt"); }
      assert.deepStrictEqual(hits[0].hits, [near.sessionId]);
      assert.strictEqual(player(near).hp, MAX_HP - TORRENT.damage);
      assert.deepStrictEqual([...player(near).effects], ["slow"]);
      assert.ok(player(near).z > 0 || player(near).vz > 0, "hurled into the air");
      assert.strictEqual(player(caster).hp, MAX_HP, "no self damage");
      assert.strictEqual(player(far).hp, MAX_HP);
    });

    it("pulls the target into range, enforces the cooldown, refuses fire mages and junk", async () => {
      const room = await colyseus.createRoom<MyRoomState>("my_room", {});
      const caster = await colyseus.connectTo(room, { element: "water" });
      const fire = await colyseus.connectTo(room, { element: "fire" });
      Object.assign(room.state.players.get(caster.sessionId), { x: 100, y: 300 });

      const charging: TorrentCharging[] = [];
      for (const c of [caster, fire]) { c.onMessage(SERVER_MESSAGE.torrentCharging, (m: TorrentCharging) => charging.push(m)); }
      fire.send(CLIENT_MESSAGE.torrent, { x: 400, y: 300 });
      for (const junk of [{}, { x: "1", y: 0 }, { x: 0 }, { x: Infinity, y: 0 }, null]) {
        caster.send(CLIENT_MESSAGE.torrent, junk as any);
      }
      caster.send(CLIENT_MESSAGE.torrent, { x: 790, y: 300 });
      caster.send(CLIENT_MESSAGE.torrent, { x: 200, y: 300 }); // still on cooldown
      await sleep(200);

      assert.strictEqual(charging.length, 1);
      assert.deepStrictEqual([charging[0].x, charging[0].y], [100 + TORRENT.range, 300], "pulled into range");
      assert.strictEqual(charging[0].cooldownMs, TORRENT.cooldownMs);
    });

    it("can't be cast while frozen", async () => {
      const room = await colyseus.createRoom<MyRoomState>("my_room", {});
      const caster = await colyseus.connectTo(room, { element: "water" });
      (room as unknown as { effects: StatusEffects }).effects.apply(caster.sessionId, "frozen");

      let charging = 0;
      caster.onMessage(SERVER_MESSAGE.torrentCharging, () => charging++);
      caster.send(CLIENT_MESSAGE.torrent, { x: 400, y: 300 });
      await sleep(200);
      assert.strictEqual(charging, 0);
    });
  });

  describe("Stone Skin", () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    // Kept out of earth's kit for now (Boulders took its slot): lend it back for these tests.
    const kits = ELEMENT_KITS as Record<string, ElementKit>;
    const earthKit = kits.earth;
    before(() => { kits.earth = { ...earthKit, second: "stone_skin" }; });
    after(() => { kits.earth = earthKit; });

    it("halves the damage its caster takes and slows them, on a cooldown, for earth mages only", async () => {
      const room = await colyseus.createRoom<MyRoomState>("my_room", {});
      const caster = await colyseus.connectTo(room, { element: "earth" });
      const fire = await colyseus.connectTo(room, { element: "fire" });
      const arena = room as unknown as MyRoom;
      const player = (c: { sessionId: string }) => room.state.players.get(c.sessionId);

      let casts = 0;
      caster.onMessage(SERVER_MESSAGE.stoneSkinCast, () => casts++);
      fire.send(CLIENT_MESSAGE.stoneSkin);
      caster.send(CLIENT_MESSAGE.stoneSkin);
      caster.send(CLIENT_MESSAGE.stoneSkin); // still on cooldown
      await sleep(150);

      assert.strictEqual(casts, 1);
      assert.deepStrictEqual([...player(caster).effects], ["stone_skin"]);
      assert.deepStrictEqual([...player(fire).effects], [], "not in a fire mage's kit");
      arena.damage(caster.sessionId, 20);
      assert.strictEqual(player(caster).hp, MAX_HP - 20 * (1 - STONE_SKIN.damageReductionPercent / 100), "less damage");
      assert.ok(STONE_SKIN.cooldownMs > STONE_SKIN.durationMs);
    });

    it("hurts an enemy who touches the hardened caster, once per hardening", async () => {
      const room = await colyseus.createRoom<MyRoomState>("my_room", {});
      const caster = await colyseus.connectTo(room, { element: "earth" });
      const toucher = await colyseus.connectTo(room);
      const apart = await colyseus.connectTo(room);
      const player = (c: { sessionId: string }) => room.state.players.get(c.sessionId);
      Object.assign(player(caster), { x: 400, y: 300 });
      Object.assign(player(toucher), { x: 400 + PLAYER_HALF * 2, y: 300 });
      Object.assign(player(apart), { x: 400 + STONE_SKIN.contactDistance + 10, y: 300 });

      caster.send(CLIENT_MESSAGE.stoneSkin);
      await sleep(300);

      assert.strictEqual(player(toucher).hp, MAX_HP - STONE_SKIN.contactDamage, "touching it hurts, once");
      assert.strictEqual(player(apart).hp, MAX_HP);
      assert.strictEqual(player(caster).hp, MAX_HP);
    });
  });

  describe("Boulders", () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const ours = (room: { state: MyRoomState }, ownerId: string) =>
      [...room.state.walls.values()].filter((wall) => wall.kind === "boulder" && wall.ownerId === ownerId);

    it("raises boulders ahead of the caster, spaced out in time, three at most, for earth mages only", async () => {
      const room = await colyseus.createRoom<MyRoomState>("my_room", {});
      const caster = await colyseus.connectTo(room, { element: "earth" });
      const fire = await colyseus.connectTo(room, { element: "fire" });
      Object.assign(room.state.players.get(caster.sessionId), { x: 400, y: 300, yaw: 0 });

      const raised: BoulderRaised[] = [];
      caster.onMessage(SERVER_MESSAGE.boulderRaised, (m: BoulderRaised) => raised.push(m));
      fire.send(CLIENT_MESSAGE.boulderRaise);
      caster.send(CLIENT_MESSAGE.boulderRaise);
      caster.send(CLIENT_MESSAGE.boulderRaise); // too soon
      await sleep(150);

      assert.strictEqual(raised.length, 1);
      const [first] = ours(room, caster.sessionId);
      assert.deepStrictEqual([first.x, first.y], [400, 300 - BOULDERS.raiseAhead], "just ahead along the facing (-y at yaw 0)");
      assert.strictEqual(ours(room, fire.sessionId).length, 0);

      for (let i = 0; i < 3; i++) {
        await sleep(BOULDERS.raiseIntervalMs);
        // Turn a little each time, so they don't rise in one spot.
        room.state.players.get(caster.sessionId).yaw = (i + 1) * 0.8;
        caster.send(CLIENT_MESSAGE.boulderRaise);
      }
      await sleep(150);
      assert.strictEqual(ours(room, caster.sessionId).length, BOULDERS.maxStanding, "three at most");
    });

    it("is kicked only from near it, flies along the kicker's facing and strikes the first enemy", async () => {
      const room = await colyseus.createRoom<MyRoomState>("my_room", {});
      const caster = await colyseus.connectTo(room, { element: "earth" });
      const victim = await colyseus.connectTo(room);
      const player = (c: { sessionId: string }) => room.state.players.get(c.sessionId);
      Object.assign(player(caster), { x: 400, y: 300, yaw: 0 });
      Object.assign(player(victim), { x: 400, y: 100 });

      const kicked: BoulderKicked[] = [];
      const hits: BoulderHit[] = [];
      victim.onMessage(SERVER_MESSAGE.boulderKicked, (m: BoulderKicked) => kicked.push(m));
      victim.onMessage(SERVER_MESSAGE.boulderHit, (m: BoulderHit) => hits.push(m));
      caster.send(CLIENT_MESSAGE.boulderRaise);
      await sleep(150);
      const [boulder] = ours(room, caster.sessionId);
      // Stepped well back from it.
      Object.assign(player(caster), { x: boulder.x, y: boulder.y + BOULDERS.halfDepth + PLAYER_HALF + BOULDERS.kickReach + BOULDERS.kickSlack + 10 });
      caster.send(CLIENT_MESSAGE.boulderKick, { yaw: 0 }); // standing too far from it
      await sleep(100);
      assert.strictEqual(kicked.length, 0);

      // Right where it was raised from: no need to walk up to it.
      Object.assign(player(caster), { x: 400, y: 300 });
      caster.send(CLIENT_MESSAGE.boulderKick, { yaw: 0 });
      await sleep(500);

      assert.strictEqual(kicked.length, 1, "everyone sees the kick");
      assert.strictEqual(ours(room, caster.sessionId).length, 0, "no longer standing");
      assert.deepStrictEqual(hits.map((h) => h.hitId), [victim.sessionId]);
      assert.strictEqual(player(victim).hp, MAX_HP - BOULDERS.damage);
    });
  });

  describe("Earth Wall", () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    // Kept out of earth's kit for now (Burrow took its slot): lend it back for these tests.
    const kits = ELEMENT_KITS as Record<string, ElementKit>;
    const earthKit = kits.earth;
    before(() => { kits.earth = { ...earthKit, third: "earth_wall" }; });
    after(() => { kits.earth = earthKit; });

    it("rises where aimed, in range, blocks the way, and comes down after its lifetime", async () => {
      const room = await colyseus.createRoom<MyRoomState>("my_room", {});
      const caster = await colyseus.connectTo(room, { element: "earth" });
      const fire = await colyseus.connectTo(room, { element: "fire" });
      Object.assign(room.state.players.get(caster.sessionId), { x: 100, y: 300 });

      const raised: EarthWallRaised[] = [];
      caster.onMessage(SERVER_MESSAGE.earthWallRaised, (m: EarthWallRaised) => raised.push(m));
      fire.send(CLIENT_MESSAGE.earthWall, { x: 300, y: 300 });
      for (const junk of [{}, { x: "1", y: 0 }, { x: NaN, y: 0 }, null]) { caster.send(CLIENT_MESSAGE.earthWall, junk as any); }
      caster.send(CLIENT_MESSAGE.earthWall, { x: 790, y: 300 });
      caster.send(CLIENT_MESSAGE.earthWall, { x: 200, y: 300 }); // still on cooldown
      await sleep(150);

      assert.strictEqual(raised.length, 1);
      assert.strictEqual(room.state.walls.size, 1);
      const wall = room.state.walls.get(raised[0].id);
      assert.deepStrictEqual([wall.x, wall.y, wall.ownerId], [100 + EARTH_WALL.range, 300, caster.sessionId], "pulled into range");

      await sleep(EARTH_WALL.lifetimeMs);
      assert.strictEqual(room.state.walls.size, 0, "gone after its lifetime");
    });

    it("blows up on the second cast, hurting everyone close but the caster, and is gone", async () => {
      const room = await colyseus.createRoom<MyRoomState>("my_room", {});
      const caster = await colyseus.connectTo(room, { element: "earth" });
      const near = await colyseus.connectTo(room);
      const far = await colyseus.connectTo(room);
      const player = (c: { sessionId: string }) => room.state.players.get(c.sessionId);
      Object.assign(player(caster), { x: 300, y: 300 });
      Object.assign(player(near), { x: 400 + EARTH_WALL.halfThickness + PLAYER_HALF + 5, y: 300 });
      Object.assign(player(far), { x: 600, y: 300 });

      const blasts: EarthWallBlast[] = [];
      far.onMessage(SERVER_MESSAGE.earthWallBlast, (m: EarthWallBlast) => blasts.push(m));
      caster.send(CLIENT_MESSAGE.earthWallDetonate); // nothing standing yet
      caster.send(CLIENT_MESSAGE.earthWall, { x: 400, y: 300 });
      await sleep(150);
      caster.send(CLIENT_MESSAGE.earthWallDetonate); // too soon after raising it
      await sleep(100);
      assert.strictEqual(blasts.length, 0, "no blowing it up the moment it rises");
      assert.strictEqual(room.state.walls.size, 1);

      await sleep(EARTH_WALL.detonateDelayMs);
      // Anyone it came up on is pushed out; put them back for the blast.
      Object.assign(player(near), { x: 400 + EARTH_WALL.halfThickness + PLAYER_HALF + 5, y: 300 });
      caster.send(CLIENT_MESSAGE.earthWallDetonate);
      await sleep(150);

      assert.strictEqual(blasts.length, 1, "everyone sees it, once");
      assert.deepStrictEqual(blasts[0].hits, [near.sessionId]);
      assert.strictEqual(player(near).hp, MAX_HP - EARTH_WALL.blastDamage);
      assert.strictEqual(player(far).hp, MAX_HP);
      assert.strictEqual(player(caster).hp, MAX_HP);
      assert.strictEqual(room.state.walls.size, 0);
    });

    it("stops fireballs", async () => {
      const room = await colyseus.createRoom<MyRoomState>("my_room", {});
      const earth = await colyseus.connectTo(room, { element: "earth" });
      const thrower = await colyseus.connectTo(room, { element: "fire" });
      const player = (c: { sessionId: string }) => room.state.players.get(c.sessionId);
      // The wall stands between them; the fireball flies level along -y.
      Object.assign(player(thrower), { x: 400, y: 450, yaw: 0 });
      Object.assign(player(earth), { x: 400, y: 150 });
      earth.send(CLIENT_MESSAGE.earthWall, { x: 400, y: 300 });
      await sleep(150);

      const hits: FireballHit[] = [];
      thrower.onMessage(SERVER_MESSAGE.fireballHit, (hit: FireballHit) => hits.push(hit));
      thrower.send(CLIENT_MESSAGE.fireball, { yaw: 0, pitch: 0.05 });
      await sleep(600);

      assert.strictEqual(hits.length, 1);
      assert.ok(hits[0].y >= 300, "burst on the wall's near side");
      assert.deepStrictEqual(hits[0].hits, []);
      assert.strictEqual(player(earth).hp, MAX_HP);
    });
  });

  describe("Fireball", () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    it("throws from the right hand along the view: level at eye height, forward at full speed", () => {
      // Facing -y at yaw 0, so the right hand is +x.
      const launch = launchFireball({ x: 400, y: 300, z: 0 }, { yaw: 0, pitch: 0 });
      assert.strictEqual(launch.x, 400 + FIREBALL.handOffset);
      assert.strictEqual(launch.y, 300);
      assert.strictEqual(launch.z, EYE_HEIGHT);
      assert.strictEqual(launch.vy, -FIREBALL_LAUNCH_SPEED);
      assert.strictEqual(Math.abs(launch.vx) + Math.abs(launch.vz), 0);
    });

    it("tells everyone the launch, by the shared rule, without syncing the ball in state", async () => {
      const room = await colyseus.createRoom<MyRoomState>("my_room", {});
      const caster = await colyseus.connectTo(room);
      const watcher = await colyseus.connectTo(room);
      Object.assign(room.state.players.get(caster.sessionId), { x: 400, y: 300, yaw: 0 });
      Object.assign(room.state.players.get(watcher.sessionId), { x: 100, y: 500 });

      const casts: FireballCast[] = [];
      for (const c of [caster, watcher]) { c.onMessage(SERVER_MESSAGE.fireballCast, (m: FireballCast) => casts.push(m)); }

      const aim = { yaw: 0.3, pitch: 0.2 };
      caster.send(CLIENT_MESSAGE.fireball, aim);
      await sleep(100);

      assert.strictEqual(casts.length, 2, "everyone sees the cast");
      assert.deepStrictEqual(casts[0], casts[1]);
      const { id, casterId, cooldownMs, ...launch } = casts[0];
      assert.ok(Number.isInteger(id) && id > 0);
      assert.strictEqual(casterId, caster.sessionId);
      assert.strictEqual(cooldownMs, FIREBALL.cooldownMs);
      // Exactly what the caster's client computes for the ball it throws on the click.
      assert.deepStrictEqual(launch, launchFireball({ x: 400, y: 300, z: 0 }, aim));
      assert.deepStrictEqual(Object.keys(room.state.toJSON()), ["players", "walls", "match"], "fireballs aren't in the room state");
    });

    it("enforces the cooldown and ignores junk", async () => {
      const room = await colyseus.createRoom<MyRoomState>("my_room", {});
      const caster = await colyseus.connectTo(room);

      let casts = 0;
      caster.onMessage(SERVER_MESSAGE.fireballCast, () => casts++);

      for (const junk of [{}, { yaw: "1", pitch: 0 }, { yaw: 0 }, { yaw: Infinity, pitch: 0 }, null, "boom"]) {
        caster.send(CLIENT_MESSAGE.fireball, junk as any);
      }
      caster.send(CLIENT_MESSAGE.fireball, { yaw: 0, pitch: 0 });
      caster.send(CLIENT_MESSAGE.fireball, { yaw: 1, pitch: 0 }); // still on cooldown
      await sleep(300);
      assert.strictEqual(casts, 1);

      await sleep(FIREBALL.cooldownMs); // room clock advances per tick: leave a margin
      caster.send(CLIENT_MESSAGE.fireball, { yaw: 1, pitch: 0 });
      await sleep(100);
      assert.strictEqual(casts, 2, "ready again after the cooldown");
    });

    it("arcs down under gravity, by the shared path", () => {
      // From the back of the arena, facing all of it.
      const launch = launchFireball({ x: 400, y: 580, z: 0 }, { yaw: 0, pitch: 0 });
      const later = fireballPosition(launch, 0.2);
      assert.strictEqual(later.y, 580 - FIREBALL_LAUNCH_SPEED * 0.2);
      assert.ok(later.z < EYE_HEIGHT, "a level throw drops");

      // Thrown level from eye height, it comes down on the floor short of the far wall.
      const landing = fireballLanding(launch);
      assert.strictEqual(landing.z, FIREBALL.radius);
      assert.ok(landing.y > FIREBALL.radius && landing.y < 580);
      // Lobbed a little higher, it carries further — still onto the floor.
      const lob = fireballLanding(launchFireball({ x: 400, y: 580, z: 0 }, { yaw: 0, pitch: 0.1 }));
      assert.strictEqual(lob.z, FIREBALL.radius);
      assert.ok(lob.y < landing.y);
    });

    it("blows up on the first living player it touches, hurting everyone in the blast but the caster", async () => {
      const room = await colyseus.createRoom<MyRoomState>("my_room", {});
      const caster = await colyseus.connectTo(room);
      const ghost = await colyseus.connectTo(room);
      const victim = await colyseus.connectTo(room);
      const beside = await colyseus.connectTo(room);
      const far = await colyseus.connectTo(room);
      const player = (c: { sessionId: string }) => room.state.players.get(c.sessionId);

      // Ahead of the caster (-y), well inside a level throw's arc. The ghost
      // is in the way but dead; one stands right beside the victim, one too far aside.
      Object.assign(player(caster), { x: 400, y: 300, yaw: 0 });
      Object.assign(player(ghost), { x: 410, y: 250 });
      Object.assign(player(victim), { x: 410, y: 200 });
      Object.assign(player(beside), { x: 440, y: 200 });
      Object.assign(player(far), { x: 410 + PLAYER_HALF * 2 + FIREBALL.blastRadius + 20, y: 200 });
      (room as unknown as MyRoom).damage(ghost.sessionId, MAX_HP);
      await room.waitForNextTimestep(); // deaths land at the end of the step

      const casts: FireballCast[] = [];
      caster.onMessage(SERVER_MESSAGE.fireballCast, (m: FireballCast) => casts.push(m));
      ghost.send(CLIENT_MESSAGE.fireball, { yaw: Math.PI, pitch: 0 });

      const hits: FireballHit[] = [];
      caster.onMessage(SERVER_MESSAGE.fireballHit, (hit: FireballHit) => hits.push(hit));
      caster.send(CLIENT_MESSAGE.fireball, { yaw: 0, pitch: 0 });
      await sleep(600);

      assert.deepStrictEqual(casts.map((c) => c.casterId), [caster.sessionId], "the dead can't cast");
      assert.strictEqual(hits.length, 1, "one blast: removed on hit");
      assert.strictEqual(hits[0].id, casts[0].id, "the blast names the ball");
      assert.deepStrictEqual(new Set(hits[0].hits), new Set([victim.sessionId, beside.sessionId]));
      assert.ok(hits[0].y > 200, "burst on the victim, not past it");
      assert.strictEqual(player(victim).hp, MAX_HP - FIREBALL.damage);
      assert.strictEqual(player(beside).hp, MAX_HP - FIREBALL.damage, "caught in the blast");
      assert.strictEqual(player(far).hp, MAX_HP, "outside the blast");
      assert.strictEqual(player(caster).hp, MAX_HP, "no self damage");
    });

    it("never hurts the caster, even at their own feet", async () => {
      const room = await colyseus.createRoom<MyRoomState>("my_room", {});
      const caster = await colyseus.connectTo(room);
      const neighbour = await colyseus.connectTo(room);
      Object.assign(room.state.players.get(caster.sessionId), { x: 400, y: 300, yaw: 0 });
      Object.assign(room.state.players.get(neighbour.sessionId), { x: 400 + PLAYER_HALF * 2 + 10, y: 300 });

      const hits: FireballHit[] = [];
      caster.onMessage(SERVER_MESSAGE.fireballHit, (hit: FireballHit) => hits.push(hit));
      caster.send(CLIENT_MESSAGE.fireball, { yaw: 0, pitch: -100 });
      await sleep(500);

      assert.deepStrictEqual(hits[0]?.hits, [neighbour.sessionId]);
      assert.strictEqual(room.state.players.get(caster.sessionId).hp, MAX_HP);
    });

    it("credits the kill to the caster's fireball", async () => {
      const room = await colyseus.createRoom<MyRoomState>("my_room", {});
      const victim = await colyseus.connectTo(room, { nickname: "Torrent" });
      const caster = await colyseus.connectTo(room, { nickname: "Blaze" });
      Object.assign(room.state.players.get(caster.sessionId), { x: 400, y: 300, yaw: 0 });
      Object.assign(room.state.players.get(victim.sessionId), { x: 400, y: 200, hp: FIREBALL.damage });

      const kills: KillEvent[] = [];
      caster.onMessage(SERVER_MESSAGE.kill, (kill: KillEvent) => kills.push(kill));
      caster.send(CLIENT_MESSAGE.fireball, { yaw: 0, pitch: 0 });
      await sleep(500);

      assert.deepStrictEqual(kills, [{
        victimId: victim.sessionId,
        victimName: "Torrent",
        killer: { id: caster.sessionId, name: "Blaze", ability: "fireball" },
      }]);
    });

    it("bursts on the wall, and on the floor where the aim line ends", async () => {
      const room = await colyseus.createRoom<MyRoomState>("my_room", {});
      const caster = await colyseus.connectTo(room);
      Object.assign(room.state.players.get(caster.sessionId), { x: 400, y: 60, yaw: 0 });

      const casts: FireballCast[] = [];
      caster.onMessage(SERVER_MESSAGE.fireballCast, (m: FireballCast) => casts.push(m));
      const hits: FireballHit[] = [];
      caster.onMessage(SERVER_MESSAGE.fireballHit, (hit: FireballHit) => hits.push(hit));

      // Level at the -y wall, 60 units away: reached before the arc drops. A
      // ball left in flight would burst again on every later tick, so one burst = removed.
      caster.send(CLIENT_MESSAGE.fireball, { yaw: 0, pitch: 0 });
      await sleep(400);
      assert.strictEqual(hits.length, 1, "one burst: removed on the wall");
      assert.strictEqual(hits[0].id, casts[0].id);
      assert.strictEqual(hits[0].y, FIREBALL.radius, "against the wall, not past it");
      assert.deepStrictEqual(hits[0].hits, []);

      // Turned around and aimed a little down, it comes down on the open floor
      // right where the shared landing rule (the caster's aim line) says.
      await sleep(FIREBALL.cooldownMs);
      caster.send(CLIENT_MESSAGE.fireball, { yaw: Math.PI, pitch: -0.2 });
      await sleep(1500);
      assert.strictEqual(hits.length, 2, "one burst: removed on the floor");
      assert.strictEqual(hits[1].id, casts[1].id);
      assert.strictEqual(hits[1].z, FIREBALL.radius, "on the floor");
      const { id, casterId, cooldownMs, ...launch } = casts[1];
      const landing = fireballLanding(launch);
      assert.ok(Math.hypot(hits[1].x - landing.x, hits[1].y - landing.y) < FIREBALL.radius, "where the aim line ends");
    });
  });

  describe("Twin Dragons", () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    it("curves one stream out to each side and meets at the target", () => {
      const origin = { x: 400, y: 300 };
      const target = { x: 400, y: 100 }; // straight ahead at yaw 0 (forward is -y)
      assert.deepStrictEqual(twinDragonsPoint(origin, target, -1, 0), origin);
      assert.deepStrictEqual(twinDragonsPoint(origin, target, 1, 1), target);
      assert.ok(twinDragonsPoint(origin, target, -1, 0.5).x < 400, "the left stream bows left (-x)");
      assert.ok(twinDragonsPoint(origin, target, 1, 0.5).x > 400, "the right stream bows right (+x)");
    });

    it("hits whoever a stream touches, then blasts the target but never the caster — and only the caster knows where", async () => {
      const room = await colyseus.createRoom<MyRoomState>("my_room", {});
      const caster = await colyseus.connectTo(room);
      const target = await colyseus.connectTo(room);
      const flank = await colyseus.connectTo(room);
      const far = await colyseus.connectTo(room);
      const player = (c: { sessionId: string }) => room.state.players.get(c.sessionId);

      const origin = { x: 400, y: 300 };
      const aim = { x: 400, y: 100 };
      Object.assign(player(caster), origin);
      Object.assign(player(target), aim);
      Object.assign(player(flank), twinDragonsPoint(origin, aim, -1, 0.5)); // on the left stream, far from the blast
      Object.assign(player(far), { x: 100, y: 550 });

      const casterLaunches: TwinDragonsLaunch[] = [];
      const farLaunches: TwinDragonsLaunch[] = [];
      const heads: TwinDragonsHeads[] = [];
      const blasts: TwinDragonsBlast[] = [];
      caster.onMessage(SERVER_MESSAGE.twinDragonsLaunch, (m: TwinDragonsLaunch) => casterLaunches.push(m));
      far.onMessage(SERVER_MESSAGE.twinDragonsLaunch, (m: TwinDragonsLaunch) => farLaunches.push(m));
      far.onMessage(SERVER_MESSAGE.twinDragonsHeads, (m: TwinDragonsHeads) => heads.push(m));
      far.onMessage(SERVER_MESSAGE.twinDragonsBlast, (m: TwinDragonsBlast) => blasts.push(m));

      caster.send(CLIENT_MESSAGE.twinDragons, aim);
      await sleep(TWIN_DRAGONS.travelMs / 2 + 200);

      assert.strictEqual(casterLaunches.length, 1);
      assert.deepStrictEqual(casterLaunches[0].target, aim, "the caster knows where they meet");
      assert.strictEqual(farLaunches.length, 0, "nobody else does");
      assert.ok(heads.length > 0, "everyone sees the heads coming");
      assert.ok(heads.every((m) => m.heads.length === 2 && m.heads.every((h) => h.y > aim.y)), "only where they are so far");
      assert.strictEqual(player(flank).hp, MAX_HP - TWIN_DRAGONS.streamDamage, "the left stream hit the flank, once");
      assert.ok(player(flank).effects.includes("burn"), "and set them on fire");
      assert.strictEqual(player(target).hp, MAX_HP, "nothing reaches the target before the heads do");

      await sleep(TWIN_DRAGONS.travelMs / 2 + 100);

      assert.strictEqual(blasts.length, 1);
      assert.deepStrictEqual(blasts[0].hits, [target.sessionId]);
      assert.strictEqual(player(target).hp, MAX_HP - 2 * TWIN_DRAGONS.streamDamage - TWIN_DRAGONS.damage, "both heads, then the blast");
      assert.ok(player(target).effects.includes("burn"));
      assert.strictEqual(player(flank).hp, MAX_HP - TWIN_DRAGONS.streamDamage, "never hit twice by one stream, its fire only burns");
      assert.strictEqual(player(caster).hp, MAX_HP, "no self damage");
      assert.deepStrictEqual([...player(caster).effects], [], "nor self burn");
      assert.deepStrictEqual([...player(far).effects], []);
    });

    it("leaves fire on the ground that burns whoever steps in it, but not the caster, for a while", async () => {
      const room = await colyseus.createRoom<MyRoomState>("my_room", {});
      const caster = await colyseus.connectTo(room);
      const late = await colyseus.connectTo(room);
      const later = await colyseus.connectTo(room);
      const player = (c: { sessionId: string }) => room.state.players.get(c.sessionId);

      const origin = { x: 400, y: 300 };
      const aim = { x: 400, y: 100 };
      const onPath = twinDragonsPoint(origin, aim, 1, 0.5);
      Object.assign(player(caster), origin);
      Object.assign(player(late), { x: 100, y: 550 });
      Object.assign(player(later), { x: 700, y: 550 });

      caster.send(CLIENT_MESSAGE.twinDragons, aim);
      await sleep(TWIN_DRAGONS.travelMs + 100);

      // The head is long gone: stepping on its path now meets only its fire.
      Object.assign(player(late), onPath);
      Object.assign(player(caster), onPath);
      await sleep(150);

      assert.ok(player(late).effects.includes("burn"), "the fire burns whoever steps in it");
      assert.strictEqual(player(late).hp, MAX_HP, "but doesn't hit like the head");
      assert.deepStrictEqual([...player(caster).effects], [], "the caster walks through their own fire");

      await sleep(TWIN_DRAGONS.trailMs - TWIN_DRAGONS.travelMs / 2);
      Object.assign(player(later), onPath);
      await sleep(150);

      assert.deepStrictEqual([...player(later).effects], [], "and then it's out");
    });

    it("caps the range, enforces the cooldown, and ignores junk", async () => {
      const room = await colyseus.createRoom<MyRoomState>("my_room", {});
      const caster = await colyseus.connectTo(room);
      Object.assign(room.state.players.get(caster.sessionId), { x: 50, y: 300 });

      const launches: TwinDragonsLaunch[] = [];
      caster.onMessage(SERVER_MESSAGE.twinDragonsLaunch, (m: TwinDragonsLaunch) => launches.push(m));

      for (const junk of [{}, { x: "1", y: 2 }, { x: NaN, y: 1 }, null, "boom"]) {
        caster.send(CLIENT_MESSAGE.twinDragons, junk as any);
      }
      caster.send(CLIENT_MESSAGE.twinDragons, { x: 9999, y: 300 });
      caster.send(CLIENT_MESSAGE.twinDragons, { x: 60, y: 300 }); // still on cooldown
      await sleep(300);

      assert.strictEqual(launches.length, 1);
      assert.deepStrictEqual(launches[0].target, { x: 50 + TWIN_DRAGONS.range, y: 300 }, "pulled back to the range");
      assert.strictEqual(launches[0].cooldownMs, TWIN_DRAGONS.cooldownMs);
    });
  });

  describe("Flame Breath", () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    /**
     * One input is one step: `count` of them is `count / TICK_RATE` seconds of
     * breath. Sent like a real client — one per simulation step — since the
     * server paces inputs and drops a backlog rather than replaying a burst.
     */
    const breathe = async (
      room: { waitForNextTimestep(): Promise<unknown> },
      input: { data: MoveInput; send(): void },
      count: number,
      breath = true,
    ) => {
      input.data.breath = breath;
      for (let i = 0; i < count; i++) {
        input.send();
        await room.waitForNextTimestep();
      }
    };

    it("burns players inside the cone on every tick, never outside it, the caster or the dead", async () => {
      const room = await colyseus.createRoom<MyRoomState>("my_room", {});
      const caster = await colyseus.connectTo(room);
      const inside = await colyseus.connectTo(room);
      const wide = await colyseus.connectTo(room);
      const far = await colyseus.connectTo(room);
      const behind = await colyseus.connectTo(room);
      const ghost = await colyseus.connectTo(room);
      const player = (c: { sessionId: string }) => room.state.players.get(c.sessionId);

      // Facing -y at yaw 0. `wide` is in range but 50° off the facing; `far`
      // is straight ahead but past the range plus a body's half-width.
      const angle = (50 * Math.PI) / 180;
      Object.assign(player(caster), { x: 400, y: 300, yaw: 0 });
      Object.assign(player(inside), { x: 400, y: 200 });
      Object.assign(player(wide), { x: 400 + 100 * Math.sin(angle), y: 300 - 100 * Math.cos(angle) });
      Object.assign(player(far), { x: 400, y: 300 - FLAME_BREATH.range - PLAYER_HALF - 5 });
      Object.assign(player(behind), { x: 400, y: 380 });
      Object.assign(player(ghost), { x: 410, y: 230 });
      (room as unknown as MyRoom).damage(ghost.sessionId, MAX_HP);
      await room.waitForNextTimestep(); // deaths land at the end of the step

      const input = caster.input<MoveInput>({ mode: "reliable" });
      input.data.yaw = 0;
      // 15 steps = 500 ms of breath: burns at 0, 200 and 400 ms.
      await breathe(room, input, 15);
      await sleep(300);

      assert.strictEqual(player(caster).breathing, true, "everyone sees the flames");
      assert.strictEqual(player(inside).hp, MAX_HP - 3 * FLAME_BREATH.tickDamage);
      assert.strictEqual(player(caster).hp, MAX_HP, "no self damage");
      for (const c of [wide, far, behind]) { assert.strictEqual(player(c).hp, MAX_HP); }
      assert.strictEqual(player(ghost).hp, 0, "the dead aren't burned again");

      await breathe(room, input, 1, false);
      await sleep(200);
      assert.strictEqual(player(caster).breathing, false, "letting go stops it");
      assert.strictEqual(player(inside).hp, MAX_HP - 3 * FLAME_BREATH.tickDamage);
    });

    it("ends at the longest channel, then ignores breath until the cooldown is over", async () => {
      const room = await colyseus.createRoom<MyRoomState>("my_room", {});
      const caster = await colyseus.connectTo(room);
      const target = await colyseus.connectTo(room);
      const player = (c: { sessionId: string }) => room.state.players.get(c.sessionId);
      Object.assign(player(caster), { x: 400, y: 300, yaw: 0 });
      Object.assign(player(target), { x: 400, y: 200 });

      const ends: FlameBreathEnd[] = [];
      caster.onMessage(SERVER_MESSAGE.flameBreathEnd, (m: FlameBreathEnd) => ends.push(m));
      let othersEnds = 0;
      target.onMessage(SERVER_MESSAGE.flameBreathEnd, () => othersEnds++);

      // Held well past the limit, in two batches so the input buffer never overflows.
      const input = caster.input<MoveInput>({ mode: "reliable" });
      const maxSteps = (FLAME_BREATH.maxChannelMs / 1000) * TICK_RATE;
      await breathe(room, input, 40);
      await sleep(200);
      await breathe(room, input, 40);
      await sleep(300);

      const burns = FLAME_BREATH.maxChannelMs / FLAME_BREATH.tickMs;
      assert.strictEqual(maxSteps, 60);
      assert.strictEqual(player(caster).breathing, false, "ran out of breath");
      assert.deepStrictEqual(ends, [{ cooldownMs: FLAME_BREATH.cooldownMs }]);
      assert.strictEqual(othersEnds, 0, "only the caster is told");
      assert.strictEqual(player(target).hp, MAX_HP - burns * FLAME_BREATH.tickDamage);

      // Still held, or pressed again: nothing while cooling down, and full speed.
      const { x } = player(caster);
      input.data.moveX = 1;
      await breathe(room, input, 1);
      await sleep(200);
      assert.strictEqual(player(caster).breathing, false);
      assert.strictEqual(player(target).hp, MAX_HP - burns * FLAME_BREATH.tickDamage);
      assert.ok(Math.abs(player(caster).x - (x + PLAYER_SPEED / TICK_RATE)) < 1e-6, "not slowed: the breath was refused");
      assert.strictEqual(ends.length, 1);
    });

    it("can breathe again once the cooldown is over", async () => {
      const room = await colyseus.createRoom<MyRoomState>("my_room", {});
      const caster = await colyseus.connectTo(room);
      const target = await colyseus.connectTo(room);
      const player = (c: { sessionId: string }) => room.state.players.get(c.sessionId);
      Object.assign(player(caster), { x: 400, y: 300, yaw: 0 });
      Object.assign(player(target), { x: 400, y: 200 });

      const input = caster.input<MoveInput>({ mode: "reliable" });
      await breathe(room, input, 1);
      await breathe(room, input, 1, false);
      await sleep(200);
      assert.strictEqual(player(target).hp, MAX_HP - FLAME_BREATH.tickDamage, "a tap burns once");

      await sleep(FLAME_BREATH.cooldownMs + 200); // room clock advances per tick: leave a margin
      await breathe(room, input, 1);
      await sleep(200);
      assert.strictEqual(player(target).hp, MAX_HP - 2 * FLAME_BREATH.tickDamage, "ready again");
    });

    it("slows the caster while breathing", async () => {
      const room = await colyseus.createRoom<MyRoomState>("my_room", {});
      const caster = await colyseus.connectTo(room);
      const player = room.state.players.get(caster.sessionId);
      Object.assign(player, { x: 400, y: 300 });

      const input = caster.input<MoveInput>({ mode: "reliable" });
      input.data.moveX = 1;
      input.data.yaw = 0;

      await breathe(room, input, 1, false);
      await sleep(150);
      const walked = player.x - 400;

      await breathe(room, input, 1);
      await sleep(150);
      const breathing = player.x - 400 - walked;

      assert.ok(Math.abs(walked - PLAYER_SPEED / TICK_RATE) < 1e-6);
      assert.ok(Math.abs(breathing - walked * FLAME_BREATH.moveSpeedScale) < 1e-6, "half speed");
    });

    it("credits the kill to the caster's Flame Breath", async () => {
      const room = await colyseus.createRoom<MyRoomState>("my_room", {});
      const victim = await colyseus.connectTo(room, { nickname: "Torrent" });
      const caster = await colyseus.connectTo(room, { nickname: "Blaze" });
      Object.assign(room.state.players.get(caster.sessionId), { x: 400, y: 300, yaw: 0 });
      Object.assign(room.state.players.get(victim.sessionId), { x: 400, y: 200, hp: FLAME_BREATH.tickDamage });

      const kills: KillEvent[] = [];
      caster.onMessage(SERVER_MESSAGE.kill, (kill: KillEvent) => kills.push(kill));
      await breathe(room, caster.input<MoveInput>({ mode: "reliable" }), 10);
      await sleep(300);

      assert.deepStrictEqual(kills, [{
        victimId: victim.sessionId,
        victimName: "Torrent",
        killer: { id: caster.sessionId, name: "Blaze", ability: "flame_breath" },
      }]);
    });

    it("ignores breath from the dead", async () => {
      const room = await colyseus.createRoom<MyRoomState>("my_room", {});
      const ghost = await colyseus.connectTo(room);
      const target = await colyseus.connectTo(room);
      Object.assign(room.state.players.get(ghost.sessionId), { x: 400, y: 300, yaw: 0 });
      Object.assign(room.state.players.get(target.sessionId), { x: 400, y: 200 });
      (room as unknown as MyRoom).damage(ghost.sessionId, MAX_HP);
      await room.waitForNextTimestep(); // deaths land at the end of the step

      let ends = 0;
      ghost.onMessage(SERVER_MESSAGE.flameBreathEnd, () => ends++);
      await breathe(room, ghost.input<MoveInput>({ mode: "reliable" }), 10);
      await sleep(100);

      assert.strictEqual(room.state.players.get(ghost.sessionId).breathing, false);
      assert.strictEqual(room.state.players.get(target.sessionId).hp, MAX_HP);
      assert.strictEqual(ends, 0, "no channel, so no cooldown either");
    });
  });

  it("jumps from the ground only", async () => {
    const room = await colyseus.createRoom<MyRoomState>("my_room", {});
    const client1 = await colyseus.connectTo(room);

    const player = room.state.players.get(client1.sessionId);
    assert.strictEqual(player.z, 0, "spawns on the floor");

    const input = client1.input<MoveInput>({ mode: "reliable" });
    input.data.jump = true;
    input.send();
    await room.waitForNextMessage();
    await room.waitForNextTimestep();

    const dt = 1 / TICK_RATE;
    assert.ok(player.z > 0, "took off");
    assert.strictEqual(player.vz, JUMP_SPEED - GRAVITY * dt);

    // Still holding jump mid-air: gravity keeps acting, no second take-off.
    input.send();
    await room.waitForNextMessage();
    await room.waitForNextTimestep();

    assert.ok(Math.abs(player.vz - (JUMP_SPEED - GRAVITY * dt * 2)) < 1e-9);
  });

  describe("game modes", () => {
    it("is a free-for-all unless told otherwise, and lists its mode", async () => {
      const room = await colyseus.createRoom<MyRoomState>("my_room", {});
      assert.deepStrictEqual(room.metadata, { name: `Arena ${room.roomId}`, map: DEFAULT_MAP, quickPlay: false, mode: "ffa", settings: { maxPlayers: FFA.maxPlayers.default } });
      assert.strictEqual(room.maxClients, FFA.maxPlayers.default);
      assert.strictEqual(room.state.match.mode, "ffa");
      assert.strictEqual(room.state.match.phase, "playing");
    });

    it("lists a duel with its settings clamped to the limits, defaulting the rest", async () => {
      const many = await colyseus.createRoom<MyRoomState>("my_room", { mode: "duel", settings: { roundsToWin: 500 } });
      assert.deepStrictEqual(many.metadata, { name: `Arena ${many.roomId}`, map: DEFAULT_MAP, quickPlay: false, mode: "duel", settings: { roundsToWin: DUEL.roundsToWin.max } });
      assert.strictEqual(many.maxClients, DUEL.maxClients);

      const junk = await colyseus.createRoom<MyRoomState>("my_room", { mode: "duel", settings: { roundsToWin: "lots", evil: 1 } } as any);
      assert.deepStrictEqual(junk.metadata.settings, { roundsToWin: DUEL.roundsToWin.default }, "junk defaulted, unknown fields dropped");
      assert.strictEqual(junk.state.match.roundsToWin, DUEL.roundsToWin.default);
    });

    it("seats as many as a free-for-all's creator chose, within the limits", async () => {
      const few = await colyseus.createRoom<MyRoomState>("my_room", { mode: "ffa", settings: { maxPlayers: 3 } });
      assert.deepStrictEqual(few.metadata.settings, { maxPlayers: 3 });
      assert.strictEqual(few.maxClients, 3);

      const many = await colyseus.createRoom<MyRoomState>("my_room", { mode: "ffa", settings: { maxPlayers: 500 } });
      assert.strictEqual(many.maxClients, FFA.maxPlayers.max);
    });

    it("lists a battle royale with its settings clamped to the limits, defaulting the rest", async () => {
      const room = await colyseus.createRoom<MyRoomState>("my_room", { mode: "battleRoyale", settings: { maxPlayers: 1, roundsToWin: 4 } });
      assert.deepStrictEqual(room.metadata.settings, { maxPlayers: BATTLE_ROYALE.maxPlayers.min, roundsToWin: 4 });
      assert.strictEqual(room.maxClients, BATTLE_ROYALE.maxPlayers.min);
      assert.strictEqual(room.state.match.mode, "battleRoyale");
      assert.strictEqual(room.state.match.roundsToWin, 4);

      const junk = await colyseus.createRoom<MyRoomState>("my_room", { mode: "battleRoyale", settings: { maxPlayers: "lots" } } as any);
      assert.deepStrictEqual(junk.metadata.settings, { maxPlayers: BATTLE_ROYALE.maxPlayers.default, roundsToWin: BATTLE_ROYALE.roundsToWin.default });
    });

    it("refuses modes that don't exist", async () => {
      for (const mode of ["ctf", 42]) {
        await assert.rejects(colyseus.createRoom("my_room", { mode } as any), `rejects ${mode}`);
      }
    });
  });

  describe("maps", () => {
    it("plays the default map unless told otherwise, in the state and the listing", async () => {
      const room = await colyseus.createRoom<MyRoomState>("my_room", {});
      assert.strictEqual(room.state.match.map, DEFAULT_MAP);
      assert.strictEqual(room.metadata.map, DEFAULT_MAP);
    });

    it("plays and lists the map its creator chose, with any mode", async () => {
      for (const map of PLAYABLE_MAPS) {
        const room = await colyseus.createRoom<MyRoomState>("my_room", { map, mode: "duel" });
        assert.strictEqual(room.state.match.map, map);
        assert.strictEqual(room.metadata.map, map);
        assert.strictEqual(room.metadata.mode, "duel");
      }
    });

    it("refuses maps that are coming soon", async () => {
      for (const map of MAPS.filter((m) => !PLAYABLE_MAPS.includes(m))) {
        await assert.rejects(colyseus.createRoom("my_room", { map }), `rejects ${map}`);
      }
    });

    it("refuses maps that don't exist", async () => {
      for (const map of ["atlantis", 42, ""]) {
        await assert.rejects(colyseus.createRoom("my_room", { map } as any), `rejects ${map}`);
      }
    });
  });

  describe("a killing blow", () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    type Sender = { send(type: string, message?: unknown): void };

    /**
     * Every skill whose hit moves or slows its victim, cast by a mage at
     * (400, 300) facing -y on one 60 units straight ahead.
     */
    const killers: { skill: string; element: string; cast(caster: Sender): Promise<void> }[] = [
      { skill: "Torrent: hurls", element: "water", cast: async (c) => { c.send(CLIENT_MESSAGE.torrent, { x: 400, y: 240 }); await sleep(TORRENT.delayMs + 300); } },
      { skill: "Puff: blows away and pops up", element: "wind", cast: async (c) => { c.send(CLIENT_MESSAGE.puff); await sleep(200); } },
      { skill: "Freezing Stream: freezes", element: "water", cast: async (c) => { c.send(CLIENT_MESSAGE.freezingStream, { yaw: 0, pitch: 0 }); await sleep(500); } },
      { skill: "Rupture: stuns", element: "earth", cast: async (c) => { c.send(CLIENT_MESSAGE.rupture, { yaw: 0 }); await sleep(RUPTURE.windupMs + RUPTURE_TRAVEL_MS + 300); } },
      { skill: "Water Whip's lash: slows", element: "water", cast: async (c) => { c.send(CLIENT_MESSAGE.waterWhip, { yaw: 0, pitch: 0 }); await sleep(200); } },
      {
        skill: "Water Whip's shard: slows", element: "water", cast: async (c) => {
          // Two lashes cracked behind, at no one, and the third hit is the shard.
          for (let i = 0; i < 2; i++) {
            c.send(CLIENT_MESSAGE.waterWhip, { yaw: Math.PI, pitch: 0 });
            await sleep(WATER_WHIP.cooldownMs + 100);
          }
          c.send(CLIENT_MESSAGE.waterWhip, { yaw: 0, pitch: 0 });
          await sleep(WHIP_SHARD.lifetimeMs / 2);
        },
      },
      { skill: "Twin Dragons: burns", element: "fire", cast: async (c) => { c.send(CLIENT_MESSAGE.twinDragons, { x: 400, y: 240 }); await sleep(1500); } },
    ];

    for (const { skill, element, cast } of killers) it(`never launches, pushes or slows the body — ${skill}`, async () => {
      const room = await colyseus.createRoom<MyRoomState>("my_room", {});
      const caster = await colyseus.connectTo(room, { element });
      const victim = await colyseus.connectTo(room);
      const body = room.state.players.get(victim.sessionId);
      Object.assign(room.state.players.get(caster.sessionId), { x: 400, y: 300, yaw: 0 });
      Object.assign(body, { x: 400, y: 240, hp: 1 });
      const { z } = body;

      // The body as the step that kills them leaves it, just before their death clears it.
      const arena = room as unknown as { die(sessionId: string, player: Player, source?: DamageSource): void };
      const die = arena.die.bind(arena);
      let atDeath: { effects: string[]; dashTime: number; vz: number; flightZ: number } | undefined;
      arena.die = (sessionId, player, source) => {
        if (sessionId === victim.sessionId) {
          atDeath = { effects: [...player.effects], dashTime: player.dashTime, vz: player.vz, flightZ: player.flightZ };
        }
        die(sessionId, player, source);
      };

      await cast(caster);
      await room.waitForNextTimestep();

      assert.strictEqual(body.hp, 0, "killed");
      assert.deepStrictEqual(atDeath, { effects: [], dashTime: 0, vz: 0, flightZ: 0 }, "untouched by the blow");
      assert.strictEqual(body.z, z, "still on the ground");
    });
  });

  describe("killed, still acting until the step ends", () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    /**
     * Every cast that puts something on its own caster (Stone Skin would too,
     * but no kit has it): what everyone is told, and what must be on the
     * caster for the cast to have landed.
     */
    const selfCasts: { skill: string; element: string; message: string; payload?: unknown; told: string; landed(body: Player): boolean }[] = [
      { skill: "Puff's speed boost", element: "wind", message: CLIENT_MESSAGE.puff, told: SERVER_MESSAGE.puffCast, landed: (b) => b.effects.includes("speed_boost") },
      { skill: "Skyfall's soaring", element: "wind", message: CLIENT_MESSAGE.skyfall, told: SERVER_MESSAGE.skyfallRise, landed: (b) => b.effects.includes("soaring") },
      { skill: "Leap's dash", element: "wind", message: CLIENT_MESSAGE.leap, payload: { yaw: 0 }, told: SERVER_MESSAGE.leapCast, landed: (b) => b.dashTime > 0 },
      {
        skill: "Burrow's dig: no walking, no casting", element: "earth", message: CLIENT_MESSAGE.burrow, told: SERVER_MESSAGE.burrowCast,
        landed: (b) => b.effects.includes("burrowing") && !canCast(b.effects) && moveLimits(b.effects).speedScale === 0,
      },
    ];

    for (const { skill, element, message, payload, told, landed } of selfCasts) it(`a self cast lands in full, then death clears it — ${skill}`, async () => {
      const room = await colyseus.createRoom<MyRoomState>("my_room", {});
      const caster = await colyseus.connectTo(room, { element });
      const watcher = await colyseus.connectTo(room);
      const arena = room as unknown as MyRoom;
      const body = room.state.players.get(caster.sessionId);
      Object.assign(body, { x: 400, y: 300, yaw: 0 });
      let casts = 0;
      watcher.onMessage(told, () => casts++);

      // No step runs between the killing blow and the cast: the cast falls in the dying window.
      const steps = arena as unknown as { step(ctx: unknown): void };
      const step = steps.step;
      steps.step = () => {};
      arena.damage(caster.sessionId, MAX_HP);
      assert.strictEqual(body.hp, 0, "the body is dead at once");
      assert.strictEqual(arena.canAct(caster.sessionId), true, "but they act until the step ends");

      caster.send(message, payload);
      await sleep(100);
      assert.strictEqual(casts, 1, "everyone sees the cast");
      assert.ok(landed(body), "and it lands on the caster");

      steps.step = step;
      await room.waitForNextTimestep();
      assert.strictEqual(arena.canAct(caster.sessionId), false, "dead once the step ends");
      assert.deepStrictEqual([...body.effects], [], "their death clears it");
      assert.strictEqual(body.dashTime, 0);
    });
  });

  describe("Duel", () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    /** A duel room with both seats taken: A, then B, unless `bJoinsFirst`. */
    async function duel(roundsToWin = 2, { bJoinsFirst = false, element = "fire" } = {}) {
      const room = await colyseus.createRoom<MyRoomState>("my_room", { mode: "duel", settings: { roundsToWin } });
      const first = await colyseus.connectTo(room, { nickname: bJoinsFirst ? "B" : "A", element });
      const second = await colyseus.connectTo(room, { nickname: bJoinsFirst ? "A" : "B", element });
      const [a, b] = bJoinsFirst ? [second, first] : [first, second];
      const arena = room as unknown as MyRoom;
      const pa = room.state.players.get(a.sessionId);
      const pb = room.state.players.get(b.sessionId);
      /** Ends the round-over pause on the next step instead of waiting it out. */
      const skipPhase = async () => {
        (arena as unknown as { mode: { phaseEndsAt: number } }).mode.phaseEndsAt = 0;
        await room.waitForNextTimestep();
      };
      /** Both press Ready: the first round is on. */
      const start = async () => {
        a.send(CLIENT_MESSAGE.ready);
        b.send(CLIENT_MESSAGE.ready);
        await sleep(100);
        assert.strictEqual(room.state.match.phase, "fighting");
      };
      return { room, arena, a, b, pa, pb, skipPhase, start };
    }

    it("seats two, never a third", async () => {
      const { room } = await duel();
      await assert.rejects(colyseus.connectTo(room));
      assert.strictEqual(room.state.players.size, 2);
    });

    it("waits until both are ready, then fights straight away from opposite spawns, facing each other", async () => {
      const { room, arena, a, b, pa, pb } = await duel();
      assert.strictEqual(room.state.match.phase, "waiting");

      arena.damage(a.sessionId, 10);
      assert.strictEqual(pa.hp, MAX_HP, "no hits count before the match");

      a.send(CLIENT_MESSAGE.ready);
      await sleep(100);
      assert.strictEqual(pa.ready, true);
      assert.strictEqual(room.state.match.phase, "waiting", "one is not enough");

      b.send(CLIENT_MESSAGE.ready);
      await sleep(100);
      assert.strictEqual(room.state.match.phase, "fighting", "no countdown");
      assert.strictEqual(room.state.match.round, 1);
      assert.strictEqual(pa.y, pb.y);
      assert.strictEqual(Math.abs(pa.x - pb.x), DUEL.spawnOffset * 2);
      assert.ok(Math.abs(Math.abs(pa.yaw - pb.yaw) - Math.PI) < 1e-6, "facing each other");

      const { x } = pa;
      const input = a.input<MoveInput>({ mode: "reliable" });
      input.data.moveX = 1;
      input.data.moveY = 0;
      input.send();
      await room.waitForNextMessage();
      await room.waitForNextTimestep();
      assert.notStrictEqual(pa.x, x, "free to move right away");
    });

    it("a kill takes the round; the next starts fresh — full health, no cooldowns, no strike still charging", async () => {
      const { room, arena, a, b, pa, pb, skipPhase, start } = await duel();
      await start();

      let launches = 0;
      let resets = 0;
      const strikeHits: SunStrikeHit[] = [];
      a.onMessage(SERVER_MESSAGE.twinDragonsLaunch, () => launches++);
      a.onMessage(SERVER_MESSAGE.arenaReset, () => resets++);
      a.onMessage(SERVER_MESSAGE.sunStrikeHit, (hit: SunStrikeHit) => strikeHits.push(hit));
      a.send(CLIENT_MESSAGE.twinDragons, { x: 400, y: 300 });
      a.send(CLIENT_MESSAGE.sunStrike, { x: pb.x, y: pb.y });
      await sleep(100);
      assert.strictEqual(launches, 1);

      arena.damage(a.sessionId, 30);
      arena.damage(b.sessionId, MAX_HP);
      a.send(CLIENT_MESSAGE.respawn);
      await room.waitForNextTimestep();
      assert.strictEqual(room.state.match.phase, "roundOver");
      assert.strictEqual(room.state.match.roundWinnerId, a.sessionId);
      assert.strictEqual(pa.wins, 1);
      assert.strictEqual(pb.hp, 0, "nobody respawns mid-duel");

      arena.damage(a.sessionId, 10);
      assert.strictEqual(pa.hp, MAX_HP - 30, "no hits count between rounds");

      await skipPhase();
      assert.strictEqual(room.state.match.phase, "fighting");
      assert.strictEqual(room.state.match.round, 2);
      assert.deepStrictEqual([pa.hp, pb.hp], [MAX_HP, MAX_HP]);
      await sleep(100);
      assert.strictEqual(resets, 1, "clients are told to drop what they draw");

      a.send(CLIENT_MESSAGE.twinDragons, { x: 400, y: 300 });
      await sleep(SUN_STRIKE.delayMs);
      assert.strictEqual(launches, 2, "the ultimate's cooldown was reset");
      assert.deepStrictEqual(strikeHits, [], "the strike from last round never landed");
    });

    it("both down in the same step is a draw: nobody scores", async () => {
      const { room, arena, a, b, pa, pb, start } = await duel();
      await start();

      arena.damage(a.sessionId, MAX_HP);
      arena.damage(b.sessionId, MAX_HP);
      await room.waitForNextTimestep();

      assert.strictEqual(room.state.match.phase, "roundOver");
      assert.strictEqual(room.state.match.roundWinnerId, "");
      assert.deepStrictEqual([pa.wins, pb.wins], [0, 0]);
    });

    for (const bJoinsFirst of [false, true]) it(`two mages breathing each other to death on the same step is a draw (${bJoinsFirst ? "B" : "A"} joined first)`, async () => {
      const { room, a, b, pa, pb, start } = await duel(2, { bJoinsFirst });
      await start();
      await breatheEachOtherDown(room, a, b);

      assert.deepStrictEqual([pa.hp, pb.hp], [0, 0], "both burned down");
      assert.strictEqual(room.state.match.phase, "roundOver");
      assert.strictEqual(room.state.match.roundWinnerId, "", "nobody takes the round");
      assert.deepStrictEqual([pa.wins, pb.wins], [0, 0]);
    });

    for (const bJoinsFirst of [false, true]) it(`two mages whipping each other to death between the same two steps is a draw (${bJoinsFirst ? "B" : "A"} joined first)`, async () => {
      const { room, arena, a, b, pa, pb, start } = await duel(2, { bJoinsFirst, element: "water" });
      await start();

      // Face to face well inside a lash's reach, one lash from death each.
      Object.assign(pa, { x: 400, y: 340, yaw: 0 });
      Object.assign(pb, { x: 400, y: 260, yaw: Math.PI });
      arena.damage(a.sessionId, MAX_HP - WATER_WHIP.damage);
      arena.damage(b.sessionId, MAX_HP - WATER_WHIP.damage);

      // No step runs while both lashes arrive, so they land between the same two.
      const steps = arena as unknown as { step(ctx: unknown): void };
      const step = steps.step;
      steps.step = () => {};
      let casts = 0;
      a.onMessage(SERVER_MESSAGE.waterWhipCast, () => casts++);
      a.send(CLIENT_MESSAGE.waterWhip, { yaw: 0, pitch: 0 });
      b.send(CLIENT_MESSAGE.waterWhip, { yaw: Math.PI, pitch: 0 });
      await sleep(100);
      steps.step = step;
      while (room.state.match.phase === "fighting") { await room.waitForNextTimestep(); }

      assert.strictEqual(casts, 2, "both lashes were cracked");
      assert.deepStrictEqual([pa.hp, pb.hp], [0, 0], "both lashed down");
      assert.strictEqual(room.state.match.roundWinnerId, "", "nobody takes the round");
      assert.deepStrictEqual([pa.wins, pb.wins], [0, 0]);
    });

    it("the first to win enough rounds wins the match, then both must ready up again", async () => {
      const { room, arena, a, b, pa, pb, skipPhase, start } = await duel(2);
      await start();

      for (let round = 1; round <= 2; round++) {
        arena.damage(b.sessionId, MAX_HP);
        await room.waitForNextTimestep();
        await skipPhase();
      }

      assert.strictEqual(room.state.match.phase, "waiting");
      assert.strictEqual(room.state.match.matchWinnerId, a.sessionId);
      assert.deepStrictEqual([pa.wins, pb.wins], [2, 0], "the final score stays up");
      assert.deepStrictEqual([pa.hp, pb.hp], [MAX_HP, MAX_HP]);
      assert.deepStrictEqual([pa.ready, pb.ready], [false, false]);

      await start();
      assert.strictEqual(room.state.match.round, 1);
      assert.strictEqual(room.state.match.matchWinnerId, "");
      assert.deepStrictEqual([pa.wins, pb.wins], [0, 0], "a rematch starts from zero");
    });

    it("leaving mid-match forfeits it, and the seat opens for someone new", async () => {
      const { room, a, b, pa, start } = await duel();
      await start();

      await b.leave();
      await sleep(100);
      assert.strictEqual(room.state.match.phase, "waiting");
      assert.strictEqual(room.state.match.matchWinnerId, a.sessionId);
      assert.strictEqual(pa.hp, MAX_HP);

      const c = await colyseus.connectTo(room);
      const pc = room.state.players.get(c.sessionId);
      assert.strictEqual(Math.abs(pa.x - pc.x), DUEL.spawnOffset * 2, "takes the free spawn");
    });
  });

  describe("Battle royale", () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    /** A battle royale room with three seated out of `maxPlayers`: A, B, then C — B before A if `bJoinsFirst`. */
    async function battleRoyale(roundsToWin = 2, maxPlayers = 4, { bJoinsFirst = false } = {}) {
      const room = await colyseus.createRoom<MyRoomState>("my_room", { mode: "battleRoyale", settings: { roundsToWin, maxPlayers } });
      const first = await colyseus.connectTo(room, { nickname: bJoinsFirst ? "B" : "A" });
      const second = await colyseus.connectTo(room, { nickname: bJoinsFirst ? "A" : "B" });
      const [a, b] = bJoinsFirst ? [second, first] : [first, second];
      const c = await colyseus.connectTo(room, { nickname: "C" });
      const arena = room as unknown as MyRoom;
      const [pa, pb, pc] = [a, b, c].map((client) => room.state.players.get(client.sessionId)!);
      /** Ends the round-over pause on the next step instead of waiting it out. */
      const skipPhase = async () => {
        (arena as unknown as { mode: { phaseEndsAt: number } }).mode.phaseEndsAt = 0;
        await room.waitForNextTimestep();
      };
      /** Everyone presses Ready: the first round is on. */
      const start = async () => {
        for (const client of [a, b, c]) { client.send(CLIENT_MESSAGE.ready); }
        await sleep(100);
        assert.strictEqual(room.state.match.phase, "fighting");
      };
      return { room, arena, a, b, c, pa, pb, pc, skipPhase, start };
    }

    it("seats up to its player count, each at their own spawn around the centre", async () => {
      const { room, pa, pb, pc } = await battleRoyale(2, 3);
      await assert.rejects(colyseus.connectTo(room));
      const spots = new Set([pa, pb, pc].map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`));
      assert.strictEqual(spots.size, 3, "nobody shares a spawn");
      for (const p of [pa, pb, pc]) {
        assert.ok(Math.abs(Math.hypot(p.x - ARENA_WIDTH / 2, p.y - ARENA_HEIGHT / 2) - BATTLE_ROYALE.spawnRadius) < 1e-6);
      }
    });

    it("waits until everyone seated is ready, then fights", async () => {
      const { room, arena, a, b, pa } = await battleRoyale();
      arena.damage(a.sessionId, 10);
      assert.strictEqual(pa.hp, MAX_HP, "no hits count before the match");

      a.send(CLIENT_MESSAGE.ready);
      b.send(CLIENT_MESSAGE.ready);
      await sleep(100);
      assert.strictEqual(room.state.match.phase, "waiting", "two of three is not enough");
    });

    it("starts once whoever wasn't ready leaves", async () => {
      const { room, a, b, c } = await battleRoyale();
      a.send(CLIENT_MESSAGE.ready);
      b.send(CLIENT_MESSAGE.ready);
      await sleep(100);
      await c.leave();
      await sleep(100);
      assert.strictEqual(room.state.match.phase, "fighting");
    });

    it("the last one standing takes the round; nobody scores while two still stand", async () => {
      const { room, arena, a, b, c, pa, pb, pc, skipPhase, start } = await battleRoyale();
      await start();

      arena.damage(b.sessionId, MAX_HP);
      await room.waitForNextTimestep();
      assert.strictEqual(room.state.match.phase, "fighting", "two still standing");

      arena.damage(c.sessionId, MAX_HP);
      await room.waitForNextTimestep();
      assert.strictEqual(room.state.match.phase, "roundOver");
      assert.strictEqual(room.state.match.roundWinnerId, a.sessionId);
      assert.deepStrictEqual([pa.wins, pb.wins, pc.wins], [1, 0, 0]);

      await skipPhase();
      assert.strictEqual(room.state.match.round, 2);
      assert.deepStrictEqual([pa.hp, pb.hp, pc.hp], [MAX_HP, MAX_HP, MAX_HP]);
    });

    for (const bJoinsFirst of [false, true]) it(`the last two breathing each other to death on the same step is a draw (${bJoinsFirst ? "B" : "A"} joined first)`, async () => {
      const { room, arena, a, b, c, pa, pb, pc, start } = await battleRoyale(2, 4, { bJoinsFirst });
      await start();

      arena.damage(c.sessionId, MAX_HP);
      await room.waitForNextTimestep();
      assert.strictEqual(room.state.match.phase, "fighting", "down to the last two");

      await breatheEachOtherDown(room, a, b);

      assert.deepStrictEqual([pa.hp, pb.hp], [0, 0], "both burned down");
      assert.strictEqual(room.state.match.phase, "roundOver");
      assert.strictEqual(room.state.match.roundWinnerId, "", "nobody takes the round");
      assert.deepStrictEqual([pa.wins, pb.wins, pc.wins], [0, 0, 0]);
    });

    it("the first to win enough rounds wins the match, then everyone must ready up again", async () => {
      const { room, arena, a, b, c, pa, pb, pc, skipPhase, start } = await battleRoyale(2);
      await start();

      for (let round = 1; round <= 2; round++) {
        arena.damage(a.sessionId, MAX_HP);
        arena.damage(b.sessionId, MAX_HP);
        await room.waitForNextTimestep();
        await skipPhase();
      }

      assert.strictEqual(room.state.match.phase, "waiting");
      assert.strictEqual(room.state.match.matchWinnerId, c.sessionId);
      assert.deepStrictEqual([pa.wins, pb.wins, pc.wins], [0, 0, 2]);
      assert.deepStrictEqual([pa.ready, pb.ready, pc.ready], [false, false, false]);
    });

    it("someone joining mid-match sits the round out, then fights the next", async () => {
      const { room, arena, b, c, skipPhase, start } = await battleRoyale();
      await start();

      const d = await colyseus.connectTo(room);
      const pd = room.state.players.get(d.sessionId)!;
      assert.strictEqual(pd.hp, 0);

      arena.damage(b.sessionId, MAX_HP);
      arena.damage(c.sessionId, MAX_HP);
      await room.waitForNextTimestep();
      assert.strictEqual(room.state.match.phase, "roundOver", "the newcomer doesn't keep the round going");

      await skipPhase();
      assert.strictEqual(pd.hp, MAX_HP);
    });

    it("ends the match once too few are left", async () => {
      const { room, a, b, pc, start } = await battleRoyale();
      await start();

      await a.leave();
      await sleep(100);
      assert.strictEqual(room.state.match.phase, "fighting", "two can still fight it out");

      await b.leave();
      await sleep(100);
      assert.strictEqual(room.state.match.phase, "waiting");
      assert.strictEqual(room.state.match.matchWinnerId, room.state.players.keys().next().value);
      assert.strictEqual(pc.hp, MAX_HP);
    });
  });

  describe("Quick Play", () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    /** What the lobby's Quick Play button sends, through the real matchmaker. */
    const quickPlay = (mode: GameModeId, extra: Record<string, unknown> = {}) =>
      colyseus.sdk.joinOrCreate("my_room", { mode, quickPlay: true, ...extra } as any);

    /** The server side of the room a client was matched into. */
    const serverRoom = (roomId: string) => colyseus.getRoomById(roomId) as unknown as MyRoom & { state: MyRoomState; waitForNextTimestep(): Promise<void> };

    /** Ends the current timed phase (round over, match result) on the next step instead of waiting it out. */
    const skipPhase = async (room: ReturnType<typeof serverRoom>) => {
      (room as unknown as { mode: { phaseEndsAt: number } }).mode.phaseEndsAt = 0;
      await room.waitForNextTimestep();
    };

    it("puts players of a mode into one room, then a new one once it is full — never a room made from the browser", async () => {
      const browserDuel = await colyseus.createRoom<MyRoomState>("my_room", { mode: "duel" });

      const a = await quickPlay("duel", { nickname: "A" });
      const b = await quickPlay("duel", { nickname: "B" });
      assert.notStrictEqual(a.roomId, browserDuel.roomId, "a browser room is never matched");
      assert.strictEqual(a.roomId, b.roomId, "the second joins the first's room");

      const c = await quickPlay("duel", { nickname: "C" });
      assert.notStrictEqual(c.roomId, a.roomId, "the duel was full: a new one");

      const d = await quickPlay("ffa", { nickname: "D" });
      assert.ok(![a.roomId, c.roomId].includes(d.roomId), "another mode never shares a room");
      assert.strictEqual(serverRoom(d.roomId).state.match.mode, "ffa");
    });

    it("fills the fullest open room first", async () => {
      const first = await quickPlay("ffa");
      await quickPlay("ffa");
      // A second room, only reachable by being created while nothing matched.
      const emptier = await colyseus.createRoom<MyRoomState>("my_room", { mode: "ffa", quickPlay: true });
      assert.ok(emptier.metadata.quickPlay);

      const next = await quickPlay("ffa");
      assert.strictEqual(next.roomId, first.roomId);
    });

    it("runs the mode's default settings, whatever its creator asks for", async () => {
      const a = await quickPlay("battleRoyale", { settings: { maxPlayers: 3, roundsToWin: 9 } });
      const room = serverRoom(a.roomId);
      assert.deepStrictEqual(room.metadata.settings, { maxPlayers: BATTLE_ROYALE.maxPlayers.default, roundsToWin: BATTLE_ROYALE.roundsToWin.default });
      assert.strictEqual(room.maxClients, BATTLE_ROYALE.maxPlayers.default);
      assert.strictEqual(room.metadata.quickPlay, true);
      assert.strictEqual(room.state.match.autoStart, true);
    });

    it("starts a duel as soon as both are seated, with no Ready, and rematches on its own", async () => {
      const a = await quickPlay("duel", { nickname: "A" });
      const room = serverRoom(a.roomId);
      await room.waitForNextTimestep();
      assert.strictEqual(room.state.match.phase, "waiting", "one is not enough");
      a.send(CLIENT_MESSAGE.ready);
      await sleep(100);
      assert.strictEqual(room.state.players.get(a.sessionId).ready, false, "no Ready in Quick Play");

      const b = await quickPlay("duel", { nickname: "B" });
      assert.strictEqual(b.roomId, a.roomId);
      await room.waitForNextTimestep();
      assert.strictEqual(room.state.match.phase, "fighting");
      assert.strictEqual(room.state.match.round, 1);

      for (let round = 1; round <= DUEL.roundsToWin.default; round++) {
        room.damage(b.sessionId, MAX_HP);
        await room.waitForNextTimestep();
        await skipPhase(room);
      }
      assert.strictEqual(room.state.match.phase, "waiting");
      assert.strictEqual(room.state.match.matchWinnerId, a.sessionId, "the result is up");

      await room.waitForNextTimestep();
      assert.strictEqual(room.state.match.phase, "waiting", "for a while");
      await skipPhase(room);
      assert.strictEqual(room.state.match.phase, "fighting", "then the rematch starts by itself");
      assert.strictEqual(room.state.match.round, 1);
      assert.strictEqual(room.state.match.matchWinnerId, "");
    });

    it("a duel left alone drops the old result and is matched to the next player", async () => {
      const a = await quickPlay("duel", { nickname: "A" });
      const b = await quickPlay("duel", { nickname: "B" });
      const room = serverRoom(a.roomId);
      await room.waitForNextTimestep();
      assert.strictEqual(room.state.match.phase, "fighting");

      await b.leave();
      await sleep(100);
      assert.strictEqual(room.state.match.matchWinnerId, a.sessionId, "a forfeit win");
      await skipPhase(room);
      assert.strictEqual(room.state.match.phase, "waiting", "nobody to fight");
      assert.strictEqual(room.state.match.matchWinnerId, "", "the old result is gone");

      const c = await quickPlay("duel", { nickname: "C" });
      assert.strictEqual(c.roomId, a.roomId, "the free seat is matched");
      await room.waitForNextTimestep();
      assert.strictEqual(room.state.match.phase, "fighting");
    });

    it("starts a battle royale once enough are seated; a latecomer sits the round out", async () => {
      const a = await quickPlay("battleRoyale", { nickname: "A" });
      const room = serverRoom(a.roomId);
      await room.waitForNextTimestep();
      assert.strictEqual(room.state.match.phase, "waiting");

      await quickPlay("battleRoyale", { nickname: "B" });
      await room.waitForNextTimestep();
      assert.strictEqual(room.state.match.phase, "fighting", `${BATTLE_ROYALE.minPlayers} are enough`);

      const c = await quickPlay("battleRoyale", { nickname: "C" });
      assert.strictEqual(c.roomId, a.roomId, "joins the match in progress");
      assert.strictEqual(room.state.players.get(c.sessionId).hp, 0, "out until the next round");
    });
  });

  describe("lag compensation", () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    /**
     * A target stands in the lash's path, then steps aside; 100 ms later the
     * caster lashes. `renderDelay` is how far behind the caster's client says it
     * draws others: what its inputs are stamped with.
     */
    async function lashAfterTargetStepsAside(renderDelay: number) {
      const room = await colyseus.createRoom<MyRoomState>("my_room", {});
      const caster = await colyseus.connectTo(room, { element: "water" });
      const target = await colyseus.connectTo(room);
      const player = (c: { sessionId: string }) => room.state.players.get(c.sessionId)!;
      // Facing -y at yaw 0: the target stands 100 ahead.
      Object.assign(player(caster), { x: 400, y: 300, z: 0, yaw: 0 });
      Object.assign(player(target), { x: 400, y: 200, z: 0 });

      const casts: WaterWhipCast[] = [];
      caster.onMessage(SERVER_MESSAGE.waterWhipCast, (m: WaterWhipCast) => casts.push(m));
      target.onMessage(SERVER_MESSAGE.waterWhipCast, () => {});

      // Inputs flowing, standing still: each one carries the caster's stamp.
      const input = caster.input<MoveInput>({ mode: "reliable", renderDelay });
      const stand = async (ms: number) => {
        for (let t = 0; t < ms; t += 1000 / TICK_RATE) {
          Object.assign(input.data, { moveX: 0, moveY: 0, yaw: 0, jump: false, breath: false });
          input.send();
          await sleep(1000 / TICK_RATE);
        }
      };

      await stand(500);
      player(target).x = 600; // out of the cone
      await stand(100);
      caster.send(CLIENT_MESSAGE.waterWhip, { yaw: 0, pitch: 0 });
      await sleep(100);

      assert.strictEqual(casts.length, 1);
      return { cast: casts[0], targetId: target.sessionId };
    }

    it("a lash lands on whoever the caster's screen still showed in its path", async () => {
      const { cast, targetId } = await lashAfterTargetStepsAside(200);
      assert.strictEqual(cast.hitId, targetId);
      assert.ok(Math.abs(cast.end.x - 400) < 1e-6, "the lash ends where the caster saw them");
    });

    it("a client drawing everyone as they are gets no help: the lash misses", async () => {
      const { cast } = await lashAfterTargetStepsAside(0);
      assert.strictEqual(cast.hitId, undefined);
    });
  });

  describe("skills pressed in the input", () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    type Command = Pick<MoveInput, "moveX" | "moveY" | "yaw" | "jump" | "breath" | "act" | "aimX" | "aimY">;
    const still = (yaw = 0): Command => ({ moveX: 0, moveY: 0, yaw, jump: false, breath: false, act: INPUT_ACTION.none, aimX: 0, aimY: 0 });

    /**
     * Sends `commands` one a tick from a mage of `element`, and predicts them
     * as the client does — its own `ActionPrediction` around the shared
     * movement step, with nothing heard back from the room. The client never
     * has to correct itself when both end up in the very same place.
     */
    async function predictAndPlay(element: string, commands: Command[]) {
      const room = await colyseus.createRoom<MyRoomState>("my_room", {});
      const client = await colyseus.connectTo(room, { element });
      const player = room.state.players.get(client.sessionId)!;
      await sleep(100);

      const terrain = MAP_TERRAIN[parseMap(room.state.match.map) ?? DEFAULT_MAP];
      const body = {
        x: player.x, y: player.y, z: player.z, vx: player.vx, vy: player.vy, vz: player.vz, yaw: player.yaw,
        dashVx: player.dashVx, dashVy: player.dashVy, dashTime: player.dashTime, flightZ: player.flightZ,
      };
      const actions = new ActionPrediction({ lastProcessed: 0, sentCount: 0 } as ConstructorParameters<typeof ActionPrediction>[0]);
      commands.forEach((command, i) => {
        const effects = actions.beforeStep(i + 1, body, command, []);
        stepEntity(body, command, 1 / TICK_RATE, moveLimits(effects), blockedByWalls(effects) ? [] : [], terrain);
        actions.afterStep(i + 1, body);
      });

      // What the room said came of it.
      const heard: string[] = [];
      for (const type of [SERVER_MESSAGE.leapCast, SERVER_MESSAGE.burrowCast, SERVER_MESSAGE.burrowSurface, SERVER_MESSAGE.skyfallRise, SERVER_MESSAGE.skyfallDrop, SERVER_MESSAGE.skyfallLand]) {
        client.onMessage(type, () => heard.push(type));
      }

      const input = client.input<MoveInput>({ mode: "reliable" });
      for (const command of commands) {
        Object.assign(input.data, command);
        input.send();
        await sleep(1000 / TICK_RATE);
      }
      await sleep(400);

      const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
      assert.ok(near(player.x, body.x) && near(player.y, body.y) && near(player.z, body.z),
        `server (${player.x}, ${player.y}, ${player.z}) vs predicted (${body.x}, ${body.y}, ${body.z})`);
      return { room, player, body, heard };
    }

    it("a leap starts on the step it was pressed on, exactly as the client predicts", async () => {
      const commands = [still(0.7), still(0.7), { ...still(0.7), act: INPUT_ACTION.leap }, ...Array.from({ length: 30 }, () => still(0.7))];
      const { player, heard } = await predictAndPlay("wind", commands);
      assert.deepStrictEqual(heard, [SERVER_MESSAGE.leapCast]);
      assert.ok(player.dashTime === 0 && Math.hypot(player.dashVx, player.dashVy) > 0, "the leap ran its course");
    });

    it("a burrow roots, then speeds under the ground, then bursts out, step for step as the client predicts", async () => {
      const walk = (act: number = INPUT_ACTION.none): Command => ({ ...still(), moveY: -1, act });
      const commands = [
        walk(INPUT_ACTION.burrow),
        ...Array.from({ length: BURROW_DIG_STEPS + 20 }, () => walk()),
        walk(INPUT_ACTION.burrowErupt),
        ...Array.from({ length: 30 }, () => walk()),
      ];
      const { player, heard } = await predictAndPlay("earth", commands);
      assert.deepStrictEqual(heard, [SERVER_MESSAGE.burrowCast, SERVER_MESSAGE.burrowSurface], "dug in, then burst out");
      assert.ok(!player.effects.includes("burrowed") && !player.effects.includes("burrowing"), "out of the ground");
    });

    it("a skyfall rises, drops onto the chosen point once all the way up, and lands, as the client predicts", async () => {
      const commands: Command[] = [{ ...still(), act: INPUT_ACTION.skyfall }, ...Array.from({ length: 5 }, () => still())];
      const drop = { ...still(), act: INPUT_ACTION.skyfallDrop, aimX: 420.25, aimY: 210.5 };
      commands.push(drop, ...Array.from({ length: 90 }, () => still()));
      const { player, heard } = await predictAndPlay("wind", commands);
      assert.deepStrictEqual(heard, [SERVER_MESSAGE.skyfallRise, SERVER_MESSAGE.skyfallDrop, SERVER_MESSAGE.skyfallLand]);
      assert.strictEqual(player.flightZ, 0, "came down");
    });
  });
});
