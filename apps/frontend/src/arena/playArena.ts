import { Callbacks } from "@colyseus/sdk";
import { Predict } from "@colyseus/sdk/predict";
import type { MoveInput } from "@ligma/backend/rooms/schema/MyRoomState";
import { stepEntity, deadInput } from "@ligma/backend/shared/movement";
import { DEFAULT_MAP, MAP_TERRAIN, parseMap } from "@ligma/backend/shared/maps";
import { MAX_HP, RESPAWN_DELAY_MS } from "@ligma/backend/shared/constants";
import type { MagicElement } from "@ligma/backend/shared/elements";
import { SKILL_SLOTS, hasSkill, kitOf, slotOf, type SkillId, type SkillSlot } from "@ligma/backend/shared/skills";
import type { KillEvent } from "@ligma/backend/shared/combat";
import { CLIENT_MESSAGE, SERVER_MESSAGE } from "@ligma/backend/shared/messages";
import { blockedByWalls, canCast, moveLimits } from "@ligma/backend/effects/effectConfig";
import type { ArenaRoom } from "../net/arenaRoom";
import { NetSmoothing } from "../net/netSmoothing";
import { ActionPrediction } from "../net/actionPrediction";
import { INPUT_ACTION } from "@ligma/backend/shared/actions";
import { type ArenaScene, type Avatar, toWorld, setHealthBar, WORLD_SCALE } from "../render/scene";
import { Effects } from "../render/effects";
import { axis, isHeld } from "../input/keyboard";
import type { MouseLook } from "../input/mouseLook";
import { slotFor, type KeyBindings } from "../input/keyBindings";
import { $ } from "../ui/dom";
import { showKit, type Hud } from "../hud/hud";
import { KillFeed } from "../hud/killFeed";
import { MatchHud } from "../hud/matchHud";
import { StatusEffectBar } from "../hud/statusEffectBar";
import { createElementIcon } from "../ui/elements";
import { SunStrikeController } from "../skills/sunStrike/sunStrike";
import { FireballController } from "../skills/fireball/fireball";
import { FlameBreathController } from "../skills/flameBreath/flameBreath";
import { TwinDragonsController } from "../skills/twinDragons/twinDragons";
import { WaterWhipController } from "../skills/waterWhip/waterWhip";
import { TorrentController } from "../skills/torrent/torrent";
import { FreezingStreamController } from "../skills/freezingStream/freezingStream";
import { FrozenLook } from "../skills/freezingStream/frozenLook";
import { StoneSkinController } from "../skills/stoneSkin/stoneSkin";
import { EarthWallController } from "../skills/earthWall/earthWall";
import { StonesController } from "../skills/stones/stones";
import { BouldersController } from "../skills/boulders/boulders";
import { RuptureController } from "../skills/rupture/rupture";
import { BurrowController } from "../skills/burrow/burrow";
import { StunnedLook } from "../skills/rupture/stunnedLook";
import { WindPoleController } from "../skills/windPole/windPole";
import { LeapController } from "../skills/leap/leap";
import { PuffController } from "../skills/puff/puff";
import { WaterCloneController } from "../skills/waterClone/waterClone";
import { WATER_CLONE, isWaterClone } from "@ligma/backend/skills/waterClone/waterCloneConfig";
import { SkyfallController } from "../skills/skyfall/skyfall";
import type { ArenaFrame, ArenaSkillController } from "../skills/arenaFrame";
import type { SlotSkill } from "../skills/slotSkill";

/** Why a session ended: the WebSocket close code and the server's reason, if any. */
export interface ArenaLeave { code: number; reason?: string; }

/**
 * Plays one arena session: prediction, input, rendering. Resolves once the
 * room is left (by the player or the server), after everything is torn down,
 * with why it was left.
 */
export async function playArena(room: ArenaRoom, scene: ArenaScene, look: MouseLook, hud: Hud, keys: KeyBindings) {
  const predict = Predict.get(room);

  // Other players are interpolated between snapshots, not predicted, with a
  // delay that adapts to how unevenly the patches arrive.
  const remotes = new NetSmoothing(room);

  const input = room.input<MoveInput>({ mode: "reliable" });

  // The first patch is what creates our own Player.
  await new Promise<void>((resolve) => room.onStateChange.once(() => resolve()));
  const self = room.state.players.get(room.sessionId);
  look.yaw = self.yaw; // spawn facing the arena centre
  look.pitch = 0;

  // The room's map never changes; an unknown one (a newer server) draws as the default.
  const map = parseMap(room.state.match.map) ?? DEFAULT_MAP;
  scene.setMap(map);
  const terrain = MAP_TERRAIN[map];

  // Leap, Skyfall and Burrow ride our inputs, and are predicted with them.
  const actions = new ActionPrediction(input);

  predict.reconciler(self, {
    input,
    fields: ["x", "y", "z", "vx", "vy", "vz", "yaw", "dashVx", "dashVy", "dashTime", "flightZ"],
    // The same function the server runs — determinism is the whole contract —
    // limited by the same status effects (a slow, a freeze; synced, with the
    // ones our own skills put on ahead of the room), walls and ground.
    // Under the ground (Burrow), walls don't stop us — as on the server.
    step: (ctx, predicted, command) => {
      const effects = actions.beforeStep(ctx.tick, predicted, command, self.effects);
      stepEntity(predicted, command, ctx.dt, moveLimits(effects), blockedByWalls(effects) ? room.state.walls.values() : [], terrain);
      actions.afterStep(ctx.tick, predicted);
    },
  });

  // The server's sanitized version, which is what everyone else sees.
  hud.status.textContent = self.name;
  // Validated against ELEMENTS by the server on join.
  hud.elementIcon.replaceChildren(createElementIcon(self.element as MagicElement, 55));

  // Remote players only: in first person we are the camera, not a mesh.
  const avatars = new Map<string, Avatar>();
  const callbacks = Callbacks.get(room);

  // Our element's skills, slot by slot. The server validated the element
  // against these same kits on join.
  const kit = kitOf(self.element)!;
  showKit(hud, kit);
  /** The HUD slot `skill` sits in for us; null if it isn't in our kit. */
  const slotUi = (skill: SkillId) => {
    const slot = slotOf(self.element, skill);
    return slot ? hud.abilities[slot] : null;
  };

  // Every skill is built, whatever our element: others' casts are drawn by
  // the skill's own controller. Only the ones in our kit get a slot.
  const effects = new Effects();
  const sunStrike = new SunStrikeController(room, scene, effects, slotUi("sun_strike"));
  const fireball = new FireballController(room, scene, effects, slotUi("fireball"));
  const flameBreath = new FlameBreathController(room, scene, slotUi("flame_breath"));
  const twinDragons = new TwinDragonsController(room, scene, effects, slotUi("twin_dragons"));
  // Also draws the whip's shards in flight, whoever threw them.
  const waterWhip = new WaterWhipController(room, scene, effects, slotUi("water_whip"));
  const torrent = new TorrentController(room, scene, effects, slotUi("torrent"));
  // Also dresses every clone's body as water (they're remote avatars), with a circle under ours.
  const waterClone = new WaterCloneController(room, scene, effects, slotUi("water_clone"));
  const freezingStream = new FreezingStreamController(room, scene, effects, slotUi("freezing_stream"));
  // Ice on whoever is frozen, whatever froze them, and frost on our view while we are.
  const frozenLook = new FrozenLook(scene, room.sessionId);
  // Also draws everyone's stone skin, whatever our element.
  const stoneSkin = new StoneSkinController(room, scene, effects, slotUi("stone_skin"));
  // Also draws every wall standing, whoever raised it.
  const earthWall = new EarthWallController(room, scene, effects, slotUi("earth_wall"));
  const stones = new StonesController(room, scene, effects, slotUi("stones"));
  // Also draws every boulder standing or flying, whoever raised it.
  const boulders = new BouldersController(room, scene, effects, slotUi("boulders"));
  const rupture = new RuptureController(room, scene, effects, slotUi("rupture"));
  // Circling stars over whoever is stunned, and a daze over our view while we are.
  const stunnedLook = new StunnedLook(scene, room.sessionId);
  // Also hides whoever is under the ground, and draws the mound they push along.
  const burrow = new BurrowController(room, scene, effects, slotUi("burrow"), actions);
  // Wind: driven through `ArenaFrame` each frame, and the `ArenaSkillController` hooks below.
  const windPole = new WindPoleController(room, scene, effects, slotUi("wind_pole"));
  const leap = new LeapController(room, scene, effects, slotUi("leap"), actions);
  const puff = new PuffController(room, scene, effects, slotUi("puff"));
  const skyfall = new SkyfallController(room, scene, effects, slotUi("skyfall"), actions);
  const frameSkills: ArenaSkillController[] = [waterClone, burrow, windPole, leap, puff, skyfall];

  /** Where we see ourselves: our predicted position. */
  const predictedPosition = () => ({ x: predict.value(self, "x"), y: predict.value(self, "y"), z: predict.value(self, "z") });

  /**
   * A main skill as our input drives it: never selected, a click uses it
   * whenever nothing else is — along the view, from where we see ourselves.
   */
  const mainSkill = (cast: (yaw: number, pitch: number, from: { x: number; y: number; z: number }) => void): SlotSkill => ({
    selected: false,
    toggle() {},
    cancel() {},
    press: () => cast(look.yaw, look.pitch, predictedPosition()),
    release() {},
  });

  /** Each skill as our input drives it. */
  const slotSkills: Readonly<Record<SkillId, SlotSkill>> = {
    fireball: mainSkill((yaw, pitch, from) => fireball.cast(yaw, pitch, from)),
    sun_strike: sunStrike,
    flame_breath: flameBreath,
    twin_dragons: twinDragons,
    water_whip: mainSkill((yaw, pitch, from) => waterWhip.cast(yaw, pitch, from)),
    torrent,
    water_clone: waterClone,
    freezing_stream: freezingStream,
    // Kicked level along our facing: the view's pitch doesn't tilt it.
    stones: mainSkill((yaw, _pitch, from) => stones.cast(yaw, from)),
    stone_skin: stoneSkin,
    boulders,
    earth_wall: earthWall,
    burrow,
    rupture,
    wind_pole: mainSkill((yaw, pitch, from) => windPole.cast(yaw, pitch, from)),
    leap,
    puff,
    skyfall,
  };
  /** The skill in one of our slots, if the kit fills it. */
  const skillIn = (slot: SkillSlot): SlotSkill | undefined => {
    const id = kit[slot];
    return id && slotSkills[id];
  };
  const ourSkills = SKILL_SLOTS.map(skillIn).filter((skill): skill is SlotSkill => skill !== undefined);
  /** What clicks use when nothing else is selected; none for a kit still without a main skill. */
  const main = kit.main && slotSkills[kit.main];
  /** Whether clicks use the main skill: nothing else is selected. */
  const mainSelected = () => !ourSkills.some((skill) => skill.selected);

  // The room's rules never change: a duel or battle royale has rounds and no Respawn button.
  const rounds = room.state.match.mode !== "ffa";
  const matchHud = new MatchHud(room, hud.match, hud.ready);
  hud.respawn.hidden = rounds;
  hud.deathNote.hidden = !rounds;
  hud.deathNote.textContent = "Back at full health next round";

  // Health is server-owned and never predicted: the bars show what the server
  // says, and so does death — 0 HP is dead, a refill is the server's respawn.
  let dead = false;
  callbacks.listen(self, "hp", (hp) => {
    setHealthBar(hud.healthFill, hp / MAX_HP);
    hud.healthText.textContent = `${hp} / ${MAX_HP}`;
    setDead(hp <= 0);
  });

  // Server-owned too. Redrawn from the whole list once the patch is applied:
  // a removal shifts the array, so single add/remove events can arrive out of order.
  const statusEffects = new StatusEffectBar(hud.statusEffects);
  const showEffects = () => queueMicrotask(() => statusEffects.show(self.effects));
  callbacks.onAdd(self, "effects", showEffects);
  callbacks.onRemove(self, "effects", showEffects);

  function setDead(value: boolean) {
    if (value === dead) { return; }
    dead = value;
    hud.death.hidden = !dead;
    document.body.classList.toggle("dead", dead);
    if (dead) {
      ourSkills.forEach((skill) => skill.cancel());
      if (!rounds) {
        // Free the cursor so the Respawn button can be clicked.
        document.exitPointerLock();
        startRespawnCountdown();
      }
    } else {
      clearInterval(countdownTimer);
      // Respawned at a fresh spawn point, facing the arena centre.
      look.yaw = self.yaw;
      look.pitch = 0;
    }
  }

  // Counted from when *we* saw the death, which is after the server's own
  // timer started — plus a margin for its tick granularity — so the button
  // never unlocks before the server will accept the click.
  let countdownTimer = 0;
  function startRespawnCountdown() {
    const readyAt = performance.now() + RESPAWN_DELAY_MS + 100;
    const tick = () => {
      const remaining = readyAt - performance.now();
      hud.respawn.disabled = remaining > 0;
      hud.respawn.textContent = remaining > 0 ? `Respawn in ${Math.ceil(remaining / 1000)}` : "Respawn";
      if (remaining <= 0) { clearInterval(countdownTimer); }
    };
    tick();
    countdownTimer = window.setInterval(tick, 100);
  }

  // The click is a user gesture, so the mouse can be captured again right away.
  const onRespawn = () => {
    room.send(CLIENT_MESSAGE.respawn);
    look.lock();
  };
  hud.respawn.addEventListener("click", onRespawn);

  // Toggles; the click also takes the mouse back, like Respawn.
  const onReady = () => {
    room.send(CLIENT_MESSAGE.ready);
    look.lock();
  };
  hud.ready.addEventListener("click", onReady);
  // Waiting for a duel, the click on the background that takes the mouse back
  // also readies us up. Only that click: in-game clicks cast (the lock is still
  // being requested while this runs). Never un-readies: that's the button's job.
  const gameEl = $("game");
  const onBackgroundClick = () => {
    if (!look.locked && !hud.ready.hidden && !self.ready) { room.send(CLIENT_MESSAGE.ready); }
  };
  gameEl.addEventListener("click", onBackgroundClick);

  // A new duel round (or the match's end): everyone was just put back at full
  // health on their spawn — in the patch before this — and every cooldown,
  // projectile and effect is gone on the server. Drop ours, face where we stand.
  room.onMessage(SERVER_MESSAGE.arenaReset, () => {
    sunStrike.reset();
    fireball.reset();
    flameBreath.reset();
    twinDragons.reset();
    waterWhip.reset();
    torrent.reset();
    freezingStream.reset();
    stoneSkin.reset();
    earthWall.reset();
    stones.reset();
    boulders.reset();
    rupture.reset();
    frameSkills.forEach((skill) => skill.reset());
    actions.reset();
    effects.clear();
    look.yaw = self.yaw;
    look.pitch = 0;
  });

  const killFeed = new KillFeed(hud.killFeed, room.sessionId);
  room.onMessage(SERVER_MESSAGE.kill, (kill: KillEvent) => killFeed.add(kill));

  callbacks.onAdd("players", (player, sessionId) => {
    if (sessionId === room.sessionId) { return; }
    const avatar = scene.createPlayer(player.name, player.element as MagicElement);
    avatars.set(sessionId, avatar);
    remotes.add(player);
    if (hasSkill(player.element, "fireball")) { fireball.addHand(sessionId, avatar); }
    if (hasSkill(player.element, "flame_breath")) { flameBreath.addHand(sessionId, avatar); }
    if (hasSkill(player.element, "water_whip")) { waterWhip.addHand(sessionId, avatar); }
    if (hasSkill(player.element, "stones")) { stones.addHand(sessionId, avatar); }
    frameSkills.forEach((skill) => skill.addPlayer?.(sessionId, avatar, player));
    // A Water Clone's bar is out of its own health, not a mage's.
    const maxHp = isWaterClone(player) ? WATER_CLONE.hp : MAX_HP;
    callbacks.listen(player, "hp", (hp) => {
      avatar.setHealth(hp / maxHp);
      avatar.setDead(hp <= 0);
    });
  });

  // Dev aid until real attacks exist: K hurts yourself. The server ignores
  // this message in production, and production builds don't bind the key.
  // `import.meta.env.DEV` is a build-time constant, so this is stripped entirely.
  const onDebugKey = import.meta.env.DEV
    ? (e: KeyboardEvent) => {
      if (e.code === "KeyK" && !e.repeat) { room.send(CLIENT_MESSAGE.debugDamage); }
    }
    : undefined;
  if (onDebugKey) { addEventListener("keydown", onDebugKey); }

  // By physical key position, so any layout, with the slot keys chosen in the
  // lobby (Z/X/C/R by default): the main slot's key goes back to the main
  // skill, selected by default; the others' select the skill in that slot —
  // again, or a right click, goes back to the main skill. A left click uses
  // whichever is selected (a channel lasts while the button is held). Only
  // while playing — not while dead or the mouse is released over the menu.
  const onAbilityKey = (e: KeyboardEvent) => {
    if (e.repeat || !look.locked || dead) { return; }
    const slot = slotFor(keys, e.code);
    if (!slot) { return; }
    const chosen = skillIn(slot);
    if (!chosen) { return; } // a slot our kit leaves empty
    ourSkills.forEach((skill) => { if (skill !== chosen) { skill.cancel(); } });
    chosen.toggle();
  };
  const onAbilityClick = (e: MouseEvent) => {
    if (!look.locked || dead) { return; }
    // Under the ground, a click bursts out — before the check below: nothing else may be cast there.
    if (e.button === 0 && burrow.eruptByClick()) { return; }
    // Frozen: the server would refuse it anyway.
    if (e.button === 0 && !canCast(self.effects)) { return; }
    if (e.button === 0) {
      const chosen = ourSkills.find((skill) => skill.selected);
      // Standing at one of our boulders, a plain click kicks it instead of using the main skill.
      if (!chosen && boulders.kickByClick()) { return; }
      (chosen ?? main)?.press();
    }
    if (e.button === 2) { ourSkills.forEach((skill) => skill.cancel()); }
  };
  // Wherever the button comes up — even over the menu — a channel stops.
  const onAbilityRelease = (e: MouseEvent) => {
    if (e.button === 0) { ourSkills.forEach((skill) => skill.release()); }
  };
  const noContextMenu = (e: MouseEvent) => e.preventDefault();
  addEventListener("keydown", onAbilityKey);
  addEventListener("mousedown", onAbilityClick);
  addEventListener("mouseup", onAbilityRelease);
  addEventListener("contextmenu", noContextMenu);

  callbacks.onRemove("players", (player, sessionId) => {
    remotes.remove(player);
    fireball.removeHand(sessionId);
    flameBreath.removeHand(sessionId);
    waterWhip.removeHand(sessionId);
    stones.removeHand(sessionId);
    frameSkills.forEach((skill) => skill.removePlayer?.(sessionId));
    const avatar = avatars.get(sessionId);
    if (avatar) { scene.removePlayer(avatar); }
    avatars.delete(sessionId);
  });

  let frameId = 0;
  let lastFrame = performance.now();

  function frame(now: number) {
    const dt = Math.min((now - lastFrame) / 1000, 0.1);
    lastFrame = now;

    // Lag compensation: each input carries how far behind we draw everyone
    // (the SDK stamps it from Predict's default delay), so the server judges
    // our hits where we saw them. That delay follows the connection.
    predict.setDefaults({ delay: remotes.shownBehind });

    // Returns how many fixed steps came due, so the input rate follows the
    // simulation rate rather than the monitor's refresh rate.
    const steps = predict.tick(now);

    actions.prune();
    for (let i = 0; i < steps; i++) {
      // A skill pressed since the last step goes with this one (none while dead).
      const pressed = actions.next();
      // Dead: send exactly what the server will substitute anyway, so the
      // prediction never drifts from it. Breath is counted step by step.
      const command = dead
        ? { ...deadInput(look.yaw), act: INPUT_ACTION.none }
        : {
          ...pressed,
          moveX: axis(["KeyA", "ArrowLeft"], ["KeyD", "ArrowRight"]),
          moveY: axis(["KeyW", "ArrowUp"], ["KeyS", "ArrowDown"]),
          yaw: look.yaw,
          jump: isHeld("Space"),
          // Frozen: no breath, exactly as the server will vet it.
          breath: canCast(self.effects) && flameBreath.step(),
        };
      Object.assign(input.data, command);
      input.send();
    }

    remotes.update(now);
    for (const [sessionId, player] of room.state.players) {
      const avatar = avatars.get(sessionId);
      if (!avatar) { continue; }
      const { group } = avatar;
      const at = remotes.position(player);
      toWorld(at.x, at.y, group.position);
      group.position.y = at.z * WORLD_SCALE;
      group.rotation.y = player.yaw;
      fireball.setHandBusy(sessionId, player.breathing);
    }

    // Position is predicted; the view uses the live mouse yaw so looking
    // around never waits for a simulation step.
    const eye = toWorld(predict.value(self, "x"), predict.value(self, "y"));
    const height = predict.value(self, "z") * WORLD_SCALE;
    scene.setFirstPerson(eye.x, height, eye.z, look.yaw, look.pitch);

    sunStrike.update(look.locked);
    flameBreath.update(dt, look.locked && !dead, look.yaw);
    twinDragons.update(look.locked, { x: predict.value(self, "x"), y: predict.value(self, "y") });
    torrent.update(look.locked, { x: predict.value(self, "x"), y: predict.value(self, "y") });
    freezingStream.update(look.locked, avatars);
    frozenLook.update(dt, room.state.players, avatars);
    stoneSkin.update(dt, room.state.players, avatars);
    earthWall.update(dt, look.locked, { x: predict.value(self, "x"), y: predict.value(self, "y") }, look.yaw);
    rupture.update(look.locked, { x: predict.value(self, "x"), y: predict.value(self, "y") });
    boulders.update(dt, { x: predict.value(self, "x"), y: predict.value(self, "y") }, look.yaw);
    stunnedLook.update(dt, room.state.players, avatars);
    // The aim line starts where the server will launch from: our predicted position.
    const fireballAim = look.locked ? { yaw: look.yaw, pitch: look.pitch, from: predictedPosition() } : null;
    fireball.update(mainSelected(), !dead, flameBreath.breathing, fireballAim);
    waterWhip.update(mainSelected(), !dead);
    stones.update(mainSelected(), !dead);
    const arenaFrame: ArenaFrame = {
      dt, locked: look.locked, alive: !dead, mainSelected: mainSelected(),
      yaw: look.yaw, pitch: look.pitch, self: predictedPosition(), players: room.state.players, avatars,
    };
    frameSkills.forEach((skill) => skill.update(arenaFrame));
    effects.update(dt);
    matchHud.update();

    scene.render();
    frameId = requestAnimationFrame(frame);
  }

  frameId = requestAnimationFrame(frame);

  const left = await new Promise<ArenaLeave>((resolve) => room.onLeave((code, reason) => resolve({ code, reason })));

  cancelAnimationFrame(frameId);
  if (onDebugKey) { removeEventListener("keydown", onDebugKey); }
  hud.respawn.removeEventListener("click", onRespawn);
  hud.ready.removeEventListener("click", onReady);
  gameEl.removeEventListener("click", onBackgroundClick);
  setDead(false);
  matchHud.hide();
  hud.respawn.hidden = false;
  hud.deathNote.hidden = true;
  killFeed.clear();
  statusEffects.clear();
  removeEventListener("keydown", onAbilityKey);
  removeEventListener("mousedown", onAbilityClick);
  removeEventListener("mouseup", onAbilityRelease);
  removeEventListener("contextmenu", noContextMenu);
  sunStrike.dispose();
  fireball.dispose();
  flameBreath.dispose();
  twinDragons.dispose();
  waterWhip.dispose();
  torrent.dispose();
  freezingStream.dispose();
  frozenLook.dispose();
  stoneSkin.dispose();
  earthWall.dispose();
  stones.dispose();
  boulders.dispose();
  rupture.dispose();
  stunnedLook.dispose();
  frameSkills.forEach((skill) => skill.dispose());
  effects.clear();
  avatars.forEach((avatar) => scene.removePlayer(avatar));
  avatars.clear();
  remotes.dispose();
  predict.dispose();
  document.exitPointerLock();
  return left;
}
