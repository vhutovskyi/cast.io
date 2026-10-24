import * as THREE from "three";
import { PUFF, PUFF_REACH, type PuffCast, type PuffHit } from "@ligma/backend/skills/puff/puffConfig";
import { PLAYER_HEIGHT } from "@ligma/backend/shared/constants";
import { CLIENT_MESSAGE, SERVER_MESSAGE } from "@ligma/backend/shared/messages";
import { type ArenaScene, toWorld, WORLD_SCALE } from "../../render/scene";
import { type Effect, Effects, glowMaterial, glowSprite, onFloor, disposeGroup } from "../../render/effects";
import type { ArenaRoom } from "../../net/arenaRoom";
import type { AbilitySlotUi } from "../../hud/hud";
import type { SlotSkill } from "../slotSkill";
import type { ArenaFrame, ArenaSkillController } from "../arenaFrame";

/** If the server doesn't confirm a cast this fast, treat it as refused. */
const CONFIRM_TIMEOUT_MS = 1500;

const WIND = 0x9be7d8;
const WIND_PALE = 0xdcfaf3;
/** How far the burst blows out, in world units: the server's reach. */
const REACH = PUFF_REACH * WORLD_SCALE;
/** Chest height, where the burst comes from. */
const CHEST = PLAYER_HEIGHT * WORLD_SCALE * 0.5;

/** The burst: how long it takes to blow out to its reach and fade (s). */
const BURST_S = 0.45;
/** Streaks of wind swirling outward: how many, and how far round they curl on the way (radians). */
const STREAKS = 22;
const SWIRL = 1.4;
/** A victim's puff: how many tufts, and how long it lasts (s). */
const TUFTS = 7;
const TUFT_S = 0.5;
/** Our own view: streaks rushing past the edges, this far ahead of the eyes (camera space), for this long (s). */
const VIEW_DISTANCE = 0.3;
const VIEW_STREAKS = 14;
const GUST_S = 0.35;

/** Eases out: fast at first, settling at the end. */
const easeOut = (k: number) => 1 - (1 - k) ** 3;

/**
 * What everyone sees when someone puffs: a shell of wind blowing out from
 * their chest to its reach, a ring racing across the floor, and streaks of
 * wind swirling outward and fading.
 */
class BurstEffect implements Effect {
  private readonly group = new THREE.Group();
  private readonly shell = glowMaterial(WIND);
  private readonly ring = glowMaterial(WIND_PALE);
  private readonly core = glowSprite(WIND_PALE);
  private readonly shellMesh = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), this.shell);
  private readonly ringMesh = onFloor(new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 64), this.ring));
  private readonly streaks = Array.from({ length: STREAKS }, (_, i) => {
    const material = glowMaterial(i % 3 === 0 ? WIND_PALE : WIND);
    const length = 0.5 + Math.random() * 0.5;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(length, 0.06), material);
    this.group.add(mesh);
    return {
      mesh,
      material,
      angle: (i / STREAKS) * Math.PI * 2 + Math.random() * 0.3,
      height: CHEST * (0.2 + Math.random() * 1.4),
      speed: 0.8 + Math.random() * 0.4,
    };
  });
  private elapsed = 0;

  constructor(parent: THREE.Object3D, at: THREE.Vector3) {
    this.group.position.copy(at);
    this.shellMesh.position.y = CHEST;
    this.core.position.y = CHEST;
    this.ringMesh.position.y = 0.04;
    this.group.add(this.shellMesh, this.ringMesh, this.core);
    parent.add(this.group);
  }

  update(dt: number) {
    const t = (this.elapsed += dt);
    const k = Math.min(t / BURST_S, 1);
    const out = easeOut(k);
    const fade = 1 - k;

    this.shellMesh.scale.setScalar(0.3 + (REACH - 0.3) * out);
    this.shellMesh.rotation.y += dt * 4;
    this.shell.opacity = 0.22 * fade;
    this.ringMesh.scale.setScalar(0.2 + (REACH - 0.2) * out);
    this.ring.opacity = 0.7 * fade;
    this.core.scale.setScalar(1.2 + 2 * out);
    this.core.material.opacity = 0.7 * fade * fade;

    // Each streak lies along its curling path, flying out and fading.
    for (const streak of this.streaks) {
      const reach = Math.min(1, out * streak.speed);
      const angle = streak.angle + SWIRL * reach;
      const r = 0.3 + REACH * reach;
      streak.mesh.position.set(Math.cos(angle) * r, streak.height * (1 - 0.3 * reach), Math.sin(angle) * r);
      // Along the tangent-ish heading: out and round.
      streak.mesh.rotation.set(0, -angle - 0.9, 0);
      streak.mesh.scale.x = 0.4 + 1.2 * (1 - reach);
      streak.material.opacity = 0.75 * fade;
    }
    return k < 1;
  }

  dispose() {
    disposeGroup(this.group);
  }
}

/**
 * On each enemy blown away, for everyone: tufts of wind bursting off them
 * and trailing away the way they were blown, and a flash.
 */
class HitPuffEffect implements Effect {
  private readonly group = new THREE.Group();
  private readonly flash = glowSprite(WIND_PALE);
  private readonly tufts = Array.from({ length: TUFTS }, () => {
    const sprite = glowSprite(WIND);
    this.group.add(sprite);
    return { sprite, velocity: new THREE.Vector3() };
  });
  private elapsed = 0;

  constructor(parent: THREE.Object3D, at: THREE.Vector3, hit: PuffHit) {
    this.group.position.copy(at);
    this.flash.position.y = CHEST;
    this.group.add(this.flash);
    // The way they were blown, in world space (simulation y is world z).
    const away = new THREE.Vector3(hit.dirX, 0, hit.dirY);
    for (const tuft of this.tufts) {
      tuft.sprite.position.set((Math.random() - 0.5) * 0.4, CHEST * (0.4 + Math.random() * 1.2), (Math.random() - 0.5) * 0.4);
      tuft.velocity.copy(away).multiplyScalar(2 + Math.random() * 3)
        .add(new THREE.Vector3((Math.random() - 0.5) * 2, Math.random() * 1.5, (Math.random() - 0.5) * 2));
    }
    parent.add(this.group);
  }

  update(dt: number) {
    const t = (this.elapsed += dt);
    const k = Math.min(t / TUFT_S, 1);
    for (const tuft of this.tufts) {
      tuft.sprite.position.addScaledVector(tuft.velocity, dt);
      tuft.sprite.scale.setScalar(0.25 + 0.6 * k);
      tuft.sprite.material.opacity = 0.6 * (1 - k);
    }
    this.flash.scale.setScalar(0.8 + 1.5 * k);
    this.flash.material.opacity = 0.8 * (1 - k) ** 2;
    return k < 1;
  }

  dispose() {
    disposeGroup(this.group);
  }
}

/**
 * Our own view, when we puff or are blown away: streaks of wind rushing out
 * past the edges of the screen, and a pale flash fading off.
 */
class ViewGustEffect implements Effect {
  private readonly group = new THREE.Group();
  private readonly flash = glowSprite(WIND_PALE);
  private readonly streaks = Array.from({ length: VIEW_STREAKS }, (_, i) => {
    const material = glowMaterial(i % 2 ? WIND : WIND_PALE);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.08, 0.004), material);
    const angle = (i / VIEW_STREAKS) * Math.PI * 2 + Math.random() * 0.3;
    mesh.rotation.z = angle;
    this.group.add(mesh);
    return { mesh, material, angle, from: 0.05 + Math.random() * 0.08 };
  });
  private elapsed = 0;

  constructor(camera: THREE.Object3D) {
    this.flash.position.z = -VIEW_DISTANCE;
    this.flash.scale.setScalar(0.5);
    this.group.add(this.flash);
    camera.add(this.group);
  }

  update(dt: number) {
    const t = (this.elapsed += dt);
    const k = Math.min(t / GUST_S, 1);
    const out = easeOut(k);
    for (const streak of this.streaks) {
      const r = streak.from + 0.35 * out;
      streak.mesh.position.set(Math.cos(streak.angle) * r, Math.sin(streak.angle) * r * 0.65, -VIEW_DISTANCE);
      streak.mesh.scale.x = 0.6 + 1.6 * out;
      streak.material.opacity = 0.55 * (1 - k);
    }
    this.flash.material.opacity = 0.25 * (1 - k) ** 2;
    return k < 1;
  }

  dispose() {
    disposeGroup(this.group);
  }
}

/**
 * Client side of Puff: its slot's key bursts at once — no aiming, no click —
 * then the cooldown display. Also draws everyone's puffs from `puffCast`: the
 * burst from the caster, a puff off each enemy blown away, and a gust over
 * our own view when we puff or are blown. The server decides everything that
 * matters (cooldown, who is hit, the knockback, the boost). `slot` is null
 * when Puff isn't in our kit: then only others' puffs are drawn.
 */
export class PuffController implements SlotSkill, ArenaSkillController {
  /** performance.now() when the next cast is allowed; Infinity while awaiting confirmation. */
  private readyAt = 0;
  private cooldownEndsAt = 0;
  private confirmTimer = 0;
  /** The latest frame: where we and the others are drawn. Null before the first. */
  private frame: ArenaFrame | null = null;

  constructor(
    private readonly room: ArenaRoom,
    private readonly scene: ArenaScene,
    private readonly effects: Effects,
    private readonly slot: AbilitySlotUi | null,
  ) {
    room.onMessage(SERVER_MESSAGE.puffCast, (msg: PuffCast) => this.onCast(msg));
  }

  get ready() {
    return performance.now() >= this.readyAt;
  }

  /** Never selected: it has nothing to aim. */
  get selected() {
    return false;
  }

  /** Its key: puff right away, if it's ready. */
  toggle() {
    if (!this.slot || !this.ready) { return; }
    this.room.send(CLIENT_MESSAGE.puff);
    // No double-sends while the server decides; give up waiting after a while.
    this.readyAt = Infinity;
    this.confirmTimer = window.setTimeout(() => { this.readyAt = 0; }, CONFIRM_TIMEOUT_MS);
  }

  cancel() {}

  press() {}

  release() {}

  update(frame: ArenaFrame) {
    this.frame = frame;
    this.showSlot();
  }

  /**
   * Drawn where everyone is as we see them: ourselves where we predict, the
   * others where their bodies are drawn — the server's spot otherwise.
   */
  private onCast(msg: PuffCast) {
    const self = this.room.sessionId;
    if (msg.casterId === self) {
      clearTimeout(this.confirmTimer);
      // Counting from arrival keeps us a little *behind* the server's own
      // cooldown, so a cast is never sent early and silently refused.
      this.cooldownEndsAt = performance.now() + msg.cooldownMs;
      this.readyAt = this.cooldownEndsAt;
    }

    const where = (sessionId: string, fallback: { x: number; y: number; z: number }) => {
      const avatar = this.frame?.avatars.get(sessionId);
      if (avatar) { return avatar.group.position.clone(); }
      const at = sessionId === self && this.frame ? this.frame.self : fallback;
      return toWorld(at.x, at.y).setY(at.z * WORLD_SCALE);
    };

    this.effects.add(new BurstEffect(this.scene.scene, where(msg.casterId, msg)));
    if (msg.casterId === self) { this.effects.add(new ViewGustEffect(this.scene.camera)); }

    for (const hit of msg.hits) {
      if (hit.id === self) {
        this.effects.add(new ViewGustEffect(this.scene.camera));
        continue;
      }
      const victim = this.room.state.players.get(hit.id);
      if (victim) { this.effects.add(new HitPuffEffect(this.scene.scene, where(hit.id, victim), hit)); }
    }
  }

  private showSlot() {
    if (!this.slot) { return; }
    const remaining = Math.max(0, this.cooldownEndsAt - performance.now());
    this.slot.root.classList.toggle("cooling", remaining > 0);
    this.slot.root.style.setProperty("--cooldown", String(Math.min(1, remaining / PUFF.cooldownMs)));
    this.slot.cooldownText.textContent = remaining > 0 ? (remaining / 1000).toFixed(1) : "";
  }

  /** A fresh round (`arenaReset`): ready right away; the arena clears what's drawn. */
  reset() {
    clearTimeout(this.confirmTimer);
    this.readyAt = 0;
    this.cooldownEndsAt = 0;
  }

  dispose() {
    this.reset();
    this.showSlot();
  }
}
