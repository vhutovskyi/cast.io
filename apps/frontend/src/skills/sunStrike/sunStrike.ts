import * as THREE from "three";
import { SUN_STRIKE, type SunStrikeCharging, type SunStrikeHit } from "@ligma/backend/skills/sunStrike/sunStrikeConfig";
import { CLIENT_MESSAGE, SERVER_MESSAGE } from "@ligma/backend/shared/messages";
import { type ArenaScene, toWorld, WORLD_SCALE } from "../../render/scene";
import { type Effect, Effects, glowMaterial, onFloor, disposeGroup } from "../../render/effects";
import type { ArenaRoom } from "../../net/arenaRoom";
import type { AbilitySlotUi } from "../../hud/hud";
import type { SlotSkill } from "../slotSkill";

const RADIUS = SUN_STRIKE.radius * WORLD_SCALE * 1.5;
const BEAM_HEIGHT = 40;
/** If the server doesn't confirm a cast this fast, treat it as refused. */
const CONFIRM_TIMEOUT_MS = 1500;

/** Faint ring under the crosshair while Sun Strike is ready — local only. */
class AimMarker {
  readonly group = new THREE.Group();
  private readonly material = glowMaterial(0xffd27a, 0.35);

  constructor(parent: THREE.Object3D) {
    this.group.add(onFloor(new THREE.Mesh(new THREE.RingGeometry(RADIUS * 0.94, RADIUS, 64), this.material)));
    this.group.visible = false;
    parent.add(this.group);
  }

  show(target: { x: number; y: number } | null) {
    this.group.visible = target !== null;
    if (target) { toWorld(target.x, target.y, this.group.position); }
  }

  dispose() {
    disposeGroup(this.group);
  }
}

/**
 * The caster's private view of a strike on its way: a ring tightening, the
 * ground warming up and a thin column of light gathering from the sky.
 */
class ChargingEffect implements Effect {
  private readonly group = new THREE.Group();
  private readonly ring = glowMaterial(0xffb347);
  private readonly disc = glowMaterial(0xff6a2b);
  private readonly beam = glowMaterial(0xffd27a);
  private readonly beamMesh: THREE.Mesh;
  private elapsed = 0;
  private done = false;

  constructor(parent: THREE.Object3D, x: number, y: number, private readonly duration: number) {
    toWorld(x, y, this.group.position);
    this.group.add(onFloor(new THREE.Mesh(new THREE.RingGeometry(RADIUS * 0.9, RADIUS, 64), this.ring)));
    this.group.add(onFloor(new THREE.Mesh(new THREE.CircleGeometry(RADIUS, 64), this.disc), 0.02));
    this.beamMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, BEAM_HEIGHT, 16, 1, true), this.beam);
    this.beamMesh.position.y = BEAM_HEIGHT / 2;
    this.group.add(this.beamMesh);
    parent.add(this.group);
  }

  /** The hit arrived: hand over to the impact effect. */
  finish() {
    this.done = true;
  }

  update(dt: number) {
    this.elapsed += dt;
    const k = Math.min(this.elapsed / this.duration, 1);
    const pulse = 0.5 + 0.5 * Math.sin(this.elapsed * (8 + 16 * k));

    this.ring.opacity = 0.4 + 0.5 * k * pulse;
    this.disc.opacity = 0.3 * k;
    this.beam.opacity = 0.1 + 0.5 * k * k;
    const width = 0.3 + 2.2 * k * k;
    this.beamMesh.scale.set(width, 1, width);

    // Safety net if the hit message never comes (e.g. we left the room).
    return !this.done && this.elapsed < this.duration + 1;
  }

  dispose() {
    disposeGroup(this.group);
  }
}

/**
 * What everyone sees when the beam lands: a blinding column that slams down
 * and fades, a shockwave rolling outward, and a scorch mark that lingers.
 */
class ImpactEffect implements Effect {
  private readonly group = new THREE.Group();
  private readonly outer = glowMaterial(0xff8c2b);
  private readonly core = glowMaterial(0xfff1b0);
  private readonly shock = glowMaterial(0xffc06a);
  private readonly embers = glowMaterial(0xff4a1a);
  private readonly scorch = new THREE.MeshBasicMaterial({ color: 0x1a0904, transparent: true, opacity: 0, depthWrite: false });
  private readonly beams: THREE.Mesh[];
  private readonly shockMesh: THREE.Mesh;
  private elapsed = 0;

  constructor(parent: THREE.Object3D, x: number, y: number) {
    toWorld(x, y, this.group.position);

    const outer = new THREE.Mesh(new THREE.CylinderGeometry(RADIUS, RADIUS, BEAM_HEIGHT, 32, 1, true), this.outer);
    const core = new THREE.Mesh(new THREE.CylinderGeometry(RADIUS * 0.45, RADIUS * 0.45, BEAM_HEIGHT, 24, 1, true), this.core);
    this.beams = [outer, core];
    for (const beam of this.beams) {
      beam.position.y = BEAM_HEIGHT / 2;
      this.group.add(beam);
    }

    this.shockMesh = onFloor(new THREE.Mesh(new THREE.RingGeometry(RADIUS * 0.85, RADIUS, 64), this.shock), 0.05);
    this.group.add(this.shockMesh);
    this.group.add(onFloor(new THREE.Mesh(new THREE.CircleGeometry(RADIUS * 0.85, 48), this.embers), 0.04));
    this.group.add(onFloor(new THREE.Mesh(new THREE.CircleGeometry(RADIUS, 48), this.scorch), 0.015));
    parent.add(this.group);
  }

  update(dt: number) {
    const t = (this.elapsed += dt);

    // Beam: slams in over 0.12 s, holds, fades out by 0.9 s.
    const slam = Math.min(t / 0.12, 1);
    const beamFade = t < 0.3 ? 1 : Math.max(0, 1 - (t - 0.3) / 0.6);
    this.outer.opacity = 0.85 * beamFade;
    this.core.opacity = beamFade;
    for (const beam of this.beams) {
      const width = (0.25 + 0.75 * slam) * (1 - 0.3 * (1 - beamFade));
      beam.scale.set(width, 1, width);
    }

    // Shockwave: rolls out to twice the radius in 0.6 s.
    const wave = Math.min(t / 0.6, 1);
    this.shockMesh.scale.setScalar(1 + wave);
    this.shock.opacity = 0.9 * (1 - wave);

    // Ground: embers glow then cool; scorch lingers longest.
    this.embers.opacity = 0.7 * Math.max(0, 1 - t / 1.5);
    this.scorch.opacity = 0.65 * Math.min(t / 0.15, 1) * Math.max(0, 1 - Math.max(0, t - 1) / 1.5);

    return t < 2.5;
  }

  dispose() {
    disposeGroup(this.group);
  }
}

/**
 * Client side of Sun Strike: select with its slot's key, cast with a click, the caster-only charging
 * visual, the impact everyone sees, and the cooldown display. The server
 * decides everything that matters (cooldown, target, who gets hit). `slot` is
 * null when Sun Strike isn't in our kit: then only others' impacts are drawn.
 */
export class SunStrikeController implements SlotSkill {
  private readonly aim: AimMarker;
  private readonly charging = new Map<number, ChargingEffect>();
  /** performance.now() when the next cast is allowed; Infinity while awaiting confirmation. */
  private readyAt = 0;
  private cooldownEndsAt = 0;
  private confirmTimer = 0;

  constructor(
    private readonly room: ArenaRoom,
    private readonly scene: ArenaScene,
    private readonly effects: Effects,
    private readonly slot: AbilitySlotUi | null,
  ) {
    this.aim = new AimMarker(scene.scene);

    room.onMessage(SERVER_MESSAGE.sunStrikeCharging, (msg: SunStrikeCharging) => {
      clearTimeout(this.confirmTimer);
      // Counting from arrival keeps us a little *behind* the server's own
      // cooldown, so a cast is never sent early and silently refused.
      this.cooldownEndsAt = performance.now() + msg.cooldownMs;
      this.readyAt = this.cooldownEndsAt;
      this.charging.set(msg.id, this.effects.add(new ChargingEffect(scene.scene, msg.x, msg.y, msg.delayMs / 1000)));
    });

    room.onMessage(SERVER_MESSAGE.sunStrikeHit, (msg: SunStrikeHit) => {
      this.charging.get(msg.id)?.finish();
      this.charging.delete(msg.id);
      this.effects.add(new ImpactEffect(scene.scene, msg.x, msg.y));
    });
  }

  get ready() {
    return performance.now() >= this.readyAt;
  }

  /** Selected with its key and waiting for a click to cast. */
  private armed = false;

  /** Whether clicks cast Sun Strike; otherwise they throw the main skill. */
  get selected() {
    return this.armed;
  }

  /** Its key: select Sun Strike for targeting, or cancel if already selected. */
  toggle() {
    this.armed = !this.armed && this.ready && this.slot !== null;
  }

  /** Right-click, Esc, Z, leaving the room: back to the main skill. */
  cancel() {
    this.armed = false;
  }

  /**
   * Click: casts at the crosshair's ground point if selected — or, aiming at
   * the sky, where the facing direction meets the arena edge — then goes back
   * to the main skill.
   */
  press() {
    if (!this.armed || !this.ready) { return; }
    const target = this.scene.groundTarget(Infinity);
    if (!target) { return; }

    this.room.send(CLIENT_MESSAGE.sunStrike, target);
    this.armed = false;
    // No double-sends while the server decides; give up waiting after a while.
    this.readyAt = Infinity;
    this.confirmTimer = window.setTimeout(() => { this.readyAt = 0; }, CONFIRM_TIMEOUT_MS);
  }

  release() {}

  /** Per frame: aim ring and slot display. Call after the camera moves. */
  update(aiming: boolean) {
    if (!aiming) { this.armed = false; }
    this.aim.show(this.armed ? this.scene.groundTarget(Infinity) : null);
    if (!this.slot) { return; }
    this.slot.root.classList.toggle("armed", this.armed);

    const remaining = Math.max(0, this.cooldownEndsAt - performance.now());
    this.slot.root.classList.toggle("cooling", remaining > 0);
    this.slot.root.style.setProperty("--cooldown", String(remaining / SUN_STRIKE.cooldownMs));
    this.slot.cooldownText.textContent = remaining > 0 ? (remaining / 1000).toFixed(1) : "";
  }

  /**
   * A fresh round (`arenaReset`): ready right away, nothing charging. The
   * server dropped it all; the visuals go with the room's `Effects`.
   */
  reset() {
    clearTimeout(this.confirmTimer);
    this.readyAt = 0;
    this.cooldownEndsAt = 0;
    this.charging.clear();
    this.armed = false;
  }

  dispose() {
    clearTimeout(this.confirmTimer);
    this.aim.dispose();
    this.charging.clear();
    this.cooldownEndsAt = 0;
    this.update(false);
  }
}
