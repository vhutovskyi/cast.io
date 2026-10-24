import * as THREE from "three";
import {
  TORRENT, clampTorrentTarget, type GroundPoint, type TorrentCharging, type TorrentHit,
} from "@ligma/backend/skills/torrent/torrentConfig";
import { CLIENT_MESSAGE, SERVER_MESSAGE } from "@ligma/backend/shared/messages";
import { type ArenaScene, toWorld, WORLD_SCALE } from "../../render/scene";
import { type Effect, Effects, glowMaterial, glowSprite, onFloor, disposeGroup } from "../../render/effects";
import type { ArenaRoom } from "../../net/arenaRoom";
import type { AbilitySlotUi } from "../../hud/hud";
import type { SlotSkill } from "../slotSkill";

/** Who it catches, in world units: the server's radius. */
const RADIUS = TORRENT.radius * WORLD_SCALE;
const RANGE = TORRENT.range * WORLD_SCALE;
/** If the server doesn't confirm a cast this fast, treat it as refused. */
const CONFIRM_TIMEOUT_MS = 1500;

/** Bubbles rising off the spot while it charges: how many, and how long each lives (s). */
const BUBBLES = 26;
const BUBBLE_LIFE = 0.7;
/** The geyser: how high it shoots (world units), how long it rises, holds and falls back (s). */
const COLUMN_HEIGHT = 6;
const RISE_S = 0.18;
const HOLD_S = 0.35;
const FALL_S = 0.6;
/** Icicles bursting up through the floor around the geyser. */
const ICICLES = 9;
/** Spray thrown off the top of the geyser. */
const SPRAY = 40;
const GRAVITY = 14;

/**
 * While Torrent is selected, local only: how far it can be cast around us,
 * and a ring on the floor where it would erupt (pulled into range).
 */
class AimPreview {
  readonly group = new THREE.Group();
  private readonly range = onFloor(new THREE.Mesh(new THREE.RingGeometry(RANGE - 0.08, RANGE, 96), glowMaterial(0x3b8cff, 0.18)));
  private readonly ring = onFloor(new THREE.Mesh(new THREE.RingGeometry(RADIUS * 0.9, RADIUS, 48), glowMaterial(0x8fd3ff, 0.6)), 0.04);

  constructor(parent: THREE.Object3D) {
    this.group.add(this.range, this.ring);
    this.group.visible = false;
    parent.add(this.group);
  }

  show(origin: GroundPoint, target: GroundPoint | null) {
    this.group.visible = target !== null;
    if (!target) { return; }
    const at = clampTorrentTarget(origin, target);
    toWorld(origin.x, origin.y, this.range.position).setY(0.03);
    toWorld(at.x, at.y, this.ring.position).setY(0.04);
  }

  dispose() {
    disposeGroup(this.group);
  }
}

/**
 * The caster's private view of a torrent on its way, as in Dota: the water
 * under the spot starting to churn — bubbles welling up faster and faster
 * inside a ring that tightens as the eruption nears.
 */
class BubblingEffect implements Effect {
  private readonly group = new THREE.Group();
  private readonly ring = glowMaterial(0x6fc8ff);
  private readonly pool = glowMaterial(0x2a7bff);
  private readonly ringMesh: THREE.Mesh;
  private readonly bubbles = Array.from({ length: BUBBLES }, (_, i) => {
    const sprite = glowSprite(0xbfe6ff);
    this.group.add(sprite);
    return { sprite, age: -i * (BUBBLE_LIFE / BUBBLES), x: 0, z: 0 };
  });
  private elapsed = 0;
  private done = false;

  constructor(parent: THREE.Object3D, x: number, y: number, private readonly duration: number) {
    toWorld(x, y, this.group.position);
    this.ringMesh = onFloor(new THREE.Mesh(new THREE.RingGeometry(RADIUS * 0.9, RADIUS, 64), this.ring), 0.04);
    this.group.add(this.ringMesh, onFloor(new THREE.Mesh(new THREE.CircleGeometry(RADIUS, 48), this.pool), 0.02));
    parent.add(this.group);
  }

  /** It erupted: hand over to the eruption. */
  finish() {
    this.done = true;
  }

  update(dt: number) {
    const t = (this.elapsed += dt);
    const k = Math.min(t / this.duration, 1);
    this.ring.opacity = 0.35 + 0.45 * k * (0.5 + 0.5 * Math.sin(t * (6 + 14 * k)));
    this.ringMesh.scale.setScalar(1.15 - 0.15 * k);
    this.pool.opacity = 0.12 + 0.25 * k;

    // Faster and faster as it nears: each bubble rises, swells and pops.
    const pace = 0.6 + 1.6 * k;
    for (const bubble of this.bubbles) {
      bubble.age += dt * pace;
      if (bubble.age >= BUBBLE_LIFE) {
        bubble.age -= BUBBLE_LIFE;
        const angle = Math.random() * Math.PI * 2;
        const out = RADIUS * Math.sqrt(Math.random()) * 0.9;
        bubble.x = Math.cos(angle) * out;
        bubble.z = Math.sin(angle) * out;
      }
      const life = bubble.age / BUBBLE_LIFE;
      bubble.sprite.visible = life >= 0;
      bubble.sprite.position.set(bubble.x, 0.05 + 0.5 * life, bubble.z);
      bubble.sprite.scale.setScalar(0.08 + 0.18 * life);
      bubble.sprite.material.opacity = (0.4 + 0.5 * k) * Math.sin(Math.PI * Math.max(0, life));
    }

    // Safety net if the eruption message never comes (e.g. we left the room).
    return !this.done && t < this.duration + 1;
  }

  dispose() {
    disposeGroup(this.group);
  }
}

/** One icicle bursting up through the floor: where it stands, how tall, how it leans, when it breaks through. */
interface Icicle { mesh: THREE.Mesh; height: number; delay: number; }

/**
 * What everyone sees when it erupts: a column of water shooting up out of
 * the floor and crashing back down, icicles stabbing up around it, spray
 * raining off the top, and a wet ring on the floor that dries out.
 */
class EruptionEffect implements Effect {
  private readonly group = new THREE.Group();
  private readonly column = glowMaterial(0x4aa8ff);
  private readonly core = glowMaterial(0xd8f4ff);
  private readonly wave = glowMaterial(0x8fd3ff);
  private readonly wet = new THREE.MeshBasicMaterial({ color: 0x1a4f8f, transparent: true, opacity: 0, depthWrite: false });
  private readonly columns: THREE.Mesh[];
  private readonly waveMesh: THREE.Mesh;
  private readonly ice = new THREE.MeshBasicMaterial({ color: 0xcff2ff, transparent: true, opacity: 0.85, depthWrite: false });
  private readonly icicles: Icicle[] = [];
  private readonly spray = Array.from({ length: SPRAY }, () => ({ sprite: glowSprite(0x8fd3ff), velocity: new THREE.Vector3(), launched: false }));
  private elapsed = 0;

  constructor(parent: THREE.Object3D, x: number, y: number) {
    toWorld(x, y, this.group.position);

    // Open tubes, pinned at the floor: scaled up from there as the water rises.
    const outer = new THREE.Mesh(new THREE.CylinderGeometry(RADIUS * 0.75, RADIUS, 1, 32, 1, true), this.column);
    const core = new THREE.Mesh(new THREE.CylinderGeometry(RADIUS * 0.3, RADIUS * 0.5, 1, 24, 1, true), this.core);
    this.columns = [outer, core];
    for (const column of this.columns) {
      column.geometry.translate(0, 0.5, 0);
      column.scale.set(1, 0.01, 1);
      this.group.add(column);
    }

    for (let i = 0; i < ICICLES; i++) {
      const height = 0.9 + Math.random() * 1.3;
      const mesh = new THREE.Mesh(new THREE.ConeGeometry(0.16 + Math.random() * 0.1, height, 5), this.ice);
      mesh.geometry.translate(0, height / 2, 0);
      const angle = (i / ICICLES) * Math.PI * 2 + Math.random() * 0.4;
      const out = RADIUS * (0.55 + Math.random() * 0.45);
      mesh.position.set(Math.cos(angle) * out, 0, Math.sin(angle) * out);
      // Leaning outward, away from the geyser.
      mesh.rotation.set(Math.sin(angle) * 0.35, 0, -Math.cos(angle) * 0.35);
      mesh.scale.setScalar(0.01);
      this.group.add(mesh);
      this.icicles.push({ mesh, height, delay: Math.random() * 0.08 });
    }

    for (const drop of this.spray) {
      drop.sprite.visible = false;
      this.group.add(drop.sprite);
    }

    this.waveMesh = onFloor(new THREE.Mesh(new THREE.RingGeometry(RADIUS * 0.85, RADIUS, 64), this.wave), 0.05);
    this.group.add(this.waveMesh, onFloor(new THREE.Mesh(new THREE.CircleGeometry(RADIUS * 1.2, 48), this.wet), 0.015));
    parent.add(this.group);
  }

  update(dt: number) {
    const t = (this.elapsed += dt);

    // The column: shoots up, holds, collapses back into the floor.
    const rise = Math.min(t / RISE_S, 1);
    const fall = Math.max(0, Math.min((t - RISE_S - HOLD_S) / FALL_S, 1));
    const height = COLUMN_HEIGHT * (1 - (1 - rise) ** 3) * (1 - fall * fall);
    this.columns.forEach((column, i) => {
      column.scale.set(1 + 0.15 * Math.sin(t * 30 + i), Math.max(0.01, height * (i === 0 ? 1 : 1.1)), 1 + 0.15 * Math.sin(t * 30 + i));
    });
    this.column.opacity = 0.7 * (1 - fall);
    this.core.opacity = 0.9 * (1 - fall);

    // Spray: thrown off the top while it holds, raining back down.
    for (const drop of this.spray) {
      if (!drop.launched && t >= RISE_S * 0.8 && Math.random() < dt * 25) {
        drop.launched = true;
        drop.sprite.visible = true;
        const angle = Math.random() * Math.PI * 2;
        const out = 1 + Math.random() * 2.5;
        drop.sprite.position.set(0, height, 0);
        drop.velocity.set(Math.cos(angle) * out, 1 + Math.random() * 3, Math.sin(angle) * out);
      }
      if (!drop.launched) { continue; }
      drop.velocity.y -= GRAVITY * dt;
      drop.sprite.position.addScaledVector(drop.velocity, dt);
      const landed = drop.sprite.position.y <= 0.05;
      drop.sprite.scale.setScalar(0.22);
      drop.sprite.material.opacity = landed ? 0 : 0.8;
    }

    // Icicles: stab up out of the floor, hold, then melt back into it.
    const melt = Math.max(0, Math.min((t - 1.1) / 0.5, 1));
    for (const icicle of this.icicles) {
      const grow = Math.max(0, Math.min((t - icicle.delay) / 0.1, 1));
      icicle.mesh.scale.set(1, 0.01 + (1 - (1 - grow) ** 2) * (1 - melt), 1);
    }
    this.ice.opacity = 0.85 * (1 - melt);

    // The wave rolls out over the floor; the wet ring dries out last.
    const wave = Math.min(t / 0.5, 1);
    this.waveMesh.scale.setScalar(1 + wave);
    this.wave.opacity = 0.8 * (1 - wave);
    this.wet.opacity = 0.45 * Math.min(t / 0.15, 1) * Math.max(0, 1 - Math.max(0, t - 1) / 1.5);

    return t < 2.5;
  }

  dispose() {
    disposeGroup(this.group);
  }
}

/**
 * Client side of Torrent: select with its slot's key, cast with a click
 * within range, the caster-only bubbling, the eruption everyone sees, and the
 * cooldown display. The server decides everything that matters (cooldown,
 * range, who gets hit, slowed and hurled). `slot` is null when Torrent isn't
 * in our kit: then only others' eruptions are drawn.
 */
export class TorrentController implements SlotSkill {
  private readonly preview: AimPreview;
  private readonly bubbling = new Map<number, BubblingEffect>();
  /** performance.now() when the next cast is allowed; Infinity while awaiting confirmation. */
  private readyAt = 0;
  private cooldownEndsAt = 0;
  private confirmTimer = 0;
  /** Selected with its key and waiting for a click to cast. */
  private armed = false;

  constructor(
    private readonly room: ArenaRoom,
    private readonly scene: ArenaScene,
    private readonly effects: Effects,
    private readonly slot: AbilitySlotUi | null,
  ) {
    this.preview = new AimPreview(scene.scene);

    room.onMessage(SERVER_MESSAGE.torrentCharging, (msg: TorrentCharging) => {
      clearTimeout(this.confirmTimer);
      // Counting from arrival keeps us a little *behind* the server's own
      // cooldown, so a cast is never sent early and silently refused.
      this.cooldownEndsAt = performance.now() + msg.cooldownMs;
      this.readyAt = this.cooldownEndsAt;
      this.bubbling.set(msg.id, this.effects.add(new BubblingEffect(scene.scene, msg.x, msg.y, msg.delayMs / 1000)));
    });

    room.onMessage(SERVER_MESSAGE.torrentHit, (msg: TorrentHit) => {
      this.bubbling.get(msg.id)?.finish();
      this.bubbling.delete(msg.id);
      this.effects.add(new EruptionEffect(scene.scene, msg.x, msg.y));
    });
  }

  get ready() {
    return performance.now() >= this.readyAt;
  }

  /** Whether clicks cast Torrent; otherwise they use the main skill. */
  get selected() {
    return this.armed;
  }

  /** Its key: select Torrent for targeting, or cancel if already selected. */
  toggle() {
    this.armed = !this.armed && this.ready && this.slot !== null;
  }

  /** Right-click, another skill's key, death, leaving the room: back to the main skill. */
  cancel() {
    this.armed = false;
  }

  /**
   * Click: casts at the crosshair's ground point, or at max range ahead when
   * aiming past it or at the sky (the server pulls it into range too), then
   * goes back to the main skill.
   */
  press() {
    if (!this.armed || !this.ready) { return; }
    const target = this.scene.groundTarget(TORRENT.range);
    if (!target) { return; }

    this.room.send(CLIENT_MESSAGE.torrent, target);
    this.armed = false;
    // No double-sends while the server decides; give up waiting after a while.
    this.readyAt = Infinity;
    this.confirmTimer = window.setTimeout(() => { this.readyAt = 0; }, CONFIRM_TIMEOUT_MS);
  }

  release() {}

  /** Per frame, after the camera moves. `origin` is where we see ourselves: our predicted position. */
  update(aiming: boolean, origin: GroundPoint) {
    if (!aiming) { this.armed = false; }
    this.preview.show(origin, this.armed ? this.scene.groundTarget(TORRENT.range) : null);
    if (!this.slot) { return; }
    this.slot.root.classList.toggle("armed", this.armed);

    const remaining = Math.max(0, this.cooldownEndsAt - performance.now());
    this.slot.root.classList.toggle("cooling", remaining > 0);
    this.slot.root.style.setProperty("--cooldown", String(remaining / TORRENT.cooldownMs));
    this.slot.cooldownText.textContent = remaining > 0 ? (remaining / 1000).toFixed(1) : "";
  }

  /**
   * A fresh round (`arenaReset`): ready right away, nothing bubbling. The
   * server dropped it all; the visuals go with the room's `Effects`.
   */
  reset() {
    clearTimeout(this.confirmTimer);
    this.readyAt = 0;
    this.cooldownEndsAt = 0;
    this.bubbling.clear();
    this.armed = false;
  }

  dispose() {
    clearTimeout(this.confirmTimer);
    this.preview.dispose();
    this.bubbling.clear();
    this.cooldownEndsAt = 0;
    this.armed = false;
    if (!this.slot) { return; }
    this.slot.root.classList.remove("armed", "cooling");
    this.slot.root.style.setProperty("--cooldown", "0");
    this.slot.cooldownText.textContent = "";
  }
}
