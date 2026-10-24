import * as THREE from "three";
import type { Player } from "@ligma/backend/rooms/schema/MyRoomState";
import {
  WATER_CLONE, isWaterClone, type WaterCloneAim, type WaterCloneCast, type WaterCloneEnd,
} from "@ligma/backend/skills/waterClone/waterCloneConfig";
import { PLAYER_HEIGHT } from "@ligma/backend/shared/constants";
import { CLIENT_MESSAGE, SERVER_MESSAGE } from "@ligma/backend/shared/messages";
import { type ArenaScene, type Avatar, toWorld, WORLD_SCALE } from "../../render/scene";
import { type Effect, Effects, glowMaterial, glowSprite, onFloor, disposeGroup } from "../../render/effects";
import type { ArenaRoom } from "../../net/arenaRoom";
import type { AbilitySlotUi } from "../../hud/hud";
import type { SlotSkill } from "../slotSkill";
import type { ArenaFrame, ArenaSkillController } from "../arenaFrame";
import { dressAsClone } from "./cloneLook";

/** If the server doesn't confirm a cast this fast, treat it as refused. */
const CONFIRM_TIMEOUT_MS = 1500;

const WATER = 0x3b8cff;
const WATER_PALE = 0xbfe6ff;
/** Waist height, where the splash bursts from. */
const WAIST = PLAYER_HEIGHT * WORLD_SCALE * 0.4;
/** A splash: how long it lasts (s), how many drops, and how wide its ring spreads (world units). */
const SPLASH_S = 0.6;
const DROPS = 12;
const RING_REACH = 1.6;
/** Pulled down by this, in world units/s², so the drops arc back to the floor. */
const DROP_GRAVITY = 14;

/**
 * Where a clone steps out or bursts apart, for everyone: a ring of water
 * spreading across the floor, drops flung up and falling back, and a flash.
 */
class SplashEffect implements Effect {
  private readonly group = new THREE.Group();
  private readonly ring = glowMaterial(WATER_PALE);
  private readonly ringMesh = onFloor(new THREE.Mesh(new THREE.RingGeometry(0.8, 1, 48), this.ring));
  private readonly flash = glowSprite(WATER_PALE);
  private readonly drops = Array.from({ length: DROPS }, (_, i) => {
    const sprite = glowSprite(i % 3 === 0 ? WATER_PALE : WATER);
    const angle = (i / DROPS) * Math.PI * 2 + Math.random() * 0.4;
    const out = 1.5 + Math.random() * 1.5;
    this.group.add(sprite);
    return { sprite, velocity: new THREE.Vector3(Math.cos(angle) * out, 3 + Math.random() * 2.5, Math.sin(angle) * out) };
  });
  private elapsed = 0;

  constructor(parent: THREE.Object3D, at: THREE.Vector3) {
    this.group.position.copy(at);
    this.flash.position.y = WAIST;
    for (const drop of this.drops) { drop.sprite.position.y = WAIST; }
    this.group.add(this.ringMesh, this.flash);
    parent.add(this.group);
  }

  update(dt: number) {
    const t = (this.elapsed += dt);
    const k = Math.min(t / SPLASH_S, 1);
    this.ringMesh.scale.setScalar(0.2 + RING_REACH * (1 - (1 - k) ** 3));
    this.ring.opacity = 0.7 * (1 - k);
    this.flash.scale.setScalar(1 + 2 * k);
    this.flash.material.opacity = 0.7 * (1 - k) ** 2;
    for (const drop of this.drops) {
      drop.velocity.y -= DROP_GRAVITY * dt;
      drop.sprite.position.addScaledVector(drop.velocity, dt);
      drop.sprite.position.y = Math.max(0.05, drop.sprite.position.y);
      drop.sprite.scale.setScalar(0.25);
      drop.sprite.material.opacity = 0.8 * (1 - k);
    }
    return k < 1;
  }

  dispose() {
    disposeGroup(this.group);
  }
}

/**
 * Client side of Water Clone: its slot's key sends a clone out at once,
 * after whoever is under our crosshair — no click. The slot then shows it
 * out until the clone is gone, and only then the cooldown. Every clone's
 * body is a remote avatar the arena draws from the synced state; this
 * dresses it as water (with a green circle under ours) and splashes where
 * clones step out and burst apart. Its lashes are the Water Whip's, drawn by
 * that controller. The server decides everything that matters (the target,
 * the walk, the hits, the cooldown). `slot` is null when Water Clone isn't
 * in our kit: then only others' clones are drawn.
 */
export class WaterCloneController implements SlotSkill, ArenaSkillController {
  /** performance.now() when the next cast is allowed; Infinity while one is awaited or our clone is out. */
  private readyAt = 0;
  private cooldownEndsAt = 0;
  private confirmTimer = 0;
  /** Our clone's id while it is out. */
  private ours: string | null = null;
  /** The latest frame: our view, and where the bodies are drawn. Null before the first. */
  private frame: ArenaFrame | null = null;

  constructor(
    private readonly room: ArenaRoom,
    private readonly scene: ArenaScene,
    private readonly effects: Effects,
    private readonly slot: AbilitySlotUi | null,
  ) {
    room.onMessage(SERVER_MESSAGE.waterCloneCast, (msg: WaterCloneCast) => this.onCast(msg));
    room.onMessage(SERVER_MESSAGE.waterCloneEnd, (msg: WaterCloneEnd) => this.onEnd(msg));
  }

  get ready() {
    return performance.now() >= this.readyAt;
  }

  /** Never selected: the key sends it out, along our view. */
  get selected() {
    return false;
  }

  /** Its key: send a clone out after whoever we look at, if it's ready. */
  toggle() {
    if (!this.slot || !this.ready || !this.frame) { return; }
    this.room.send(CLIENT_MESSAGE.waterClone, { yaw: this.frame.yaw, pitch: this.frame.pitch } satisfies WaterCloneAim);
    // No double-sends while the server decides; give up waiting after a while.
    this.readyAt = Infinity;
    this.confirmTimer = window.setTimeout(() => { if (!this.ours) { this.readyAt = 0; } }, CONFIRM_TIMEOUT_MS);
  }

  cancel() {}

  press() {}

  release() {}

  update(frame: ArenaFrame) {
    this.frame = frame;
    this.showSlot();
  }

  /** A clone's body arrived: dress it as water, with our circle under it if it's ours. */
  addPlayer(_sessionId: string, avatar: Avatar, player: Player) {
    if (!isWaterClone(player)) { return; }
    dressAsClone(avatar, player.ownerId === this.room.sessionId);
  }

  private onCast(msg: WaterCloneCast) {
    if (msg.casterId === this.room.sessionId) {
      clearTimeout(this.confirmTimer);
      this.ours = msg.cloneId;
      this.readyAt = Infinity;
      this.cooldownEndsAt = 0;
    }
    this.splash(msg);
  }

  private onEnd(msg: WaterCloneEnd) {
    if (msg.casterId === this.room.sessionId) {
      this.ours = null;
      // Counting from arrival keeps us a little *behind* the server's own
      // cooldown, so a cast is never sent early and silently refused.
      this.cooldownEndsAt = performance.now() + msg.cooldownMs;
      this.readyAt = this.cooldownEndsAt;
    }
    // A fresh round clears what's drawn anyway.
    if (msg.reason !== "reset") { this.splash(msg); }
  }

  private splash(at: { x: number; y: number; z: number }) {
    this.effects.add(new SplashEffect(this.scene.scene, toWorld(at.x, at.y).setY(at.z * WORLD_SCALE)));
  }

  private showSlot() {
    if (!this.slot) { return; }
    const remaining = Math.max(0, this.cooldownEndsAt - performance.now());
    // Out, our clone holds the slot: it can't be cast again until it is gone.
    this.slot.root.classList.toggle("cooling", remaining > 0 || this.ours !== null);
    this.slot.root.style.setProperty("--cooldown", String(Math.min(1, remaining / WATER_CLONE.cooldownMs)));
    this.slot.cooldownText.textContent = remaining > 0 ? (remaining / 1000).toFixed(1) : "";
  }

  /** A fresh round (`arenaReset`): ready right away, no clone out; the arena clears what's drawn. */
  reset() {
    clearTimeout(this.confirmTimer);
    this.readyAt = 0;
    this.cooldownEndsAt = 0;
    this.ours = null;
  }

  dispose() {
    this.reset();
    this.showSlot();
  }
}
