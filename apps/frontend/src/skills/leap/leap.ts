import * as THREE from "three";
import { LEAP, type LeapCast, type LeapHit } from "@ligma/backend/skills/leap/leapConfig";
import { PLAYER_HEIGHT } from "@ligma/backend/shared/constants";
import { SERVER_MESSAGE } from "@ligma/backend/shared/messages";
import { INPUT_ACTION } from "@ligma/backend/shared/actions";
import { type ArenaScene, type Avatar, toWorld, WORLD_SCALE } from "../../render/scene";
import { type Effect, Effects, glowMaterial, glowSprite, onFloor, disposeGroup } from "../../render/effects";
import type { ArenaRoom } from "../../net/arenaRoom";
import type { ActionPrediction } from "../../net/actionPrediction";
import type { AbilitySlotUi } from "../../hud/hud";
import type { SlotSkill } from "../slotSkill";
import type { ArenaFrame, ArenaSkillController } from "../arenaFrame";

/** If the server doesn't confirm a cast this fast, treat it as refused. */
const CONFIRM_TIMEOUT_MS = 1500;

const WIND = 0x9be7d8;
/** Halfway up a body, in world units: where hit puffs burst. */
const CHEST = (PLAYER_HEIGHT / 2) * WORLD_SCALE;

/** One unit-long, thin tube standing along +y: every streak is this, stretched and turned. */
const streakGeometry = () => new THREE.CylinderGeometry(1, 1, 1, 5, 1, true);
const UP = new THREE.Vector3(0, 1, 0);

/** The gust at the take-off spot: a ring of air blown out across the floor, a puff, and streaks flung back. */
const GUST_S = 0.45;
const GUST_RADIUS = 1.6;
const GUST_STREAKS = 7;

/** The trail behind a leaping body: streaks this thick, at these heights, fading over this long (s). */
const TRAIL_WIDTH = 0.035;
const TRAIL_HEIGHTS = [0.35, 1.0, 1.7];
const TRAIL_SPREAD = 0.28;
const TRAIL_S = 0.4;
/**
 * How long after the cast a remote body may still be leaping as we draw it:
 * the slide, plus the interpolation that shows others a little in the past.
 */
const TRAIL_WINDOW_S = LEAP.durationMs / 1000 + 0.3;
/** Moving at least this fast (world units/s) counts as leaping, not walking. */
const TRAIL_MIN_SPEED = LEAP.speed * WORLD_SCALE * 0.5;

/** Someone was run into: a burst of air off them, and how long it lasts (s). */
const HIT_S = 0.35;

/** Our own view while we leap: streaks rushing past at the screen's edges, this far ahead of the eyes (camera space). */
const VIEW_DISTANCE = 0.3;
const VIEW_STREAKS = 18;
/** They rush in over this, and fade out over the next, in seconds. */
const VIEW_IN_S = 0.06;
const VIEW_OUT_S = 0.3;

/** A streak (from `streakGeometry`) stretched from `from` to `to`. */
function placeStreak(mesh: THREE.Mesh, from: THREE.Vector3, to: THREE.Vector3, width: number) {
  const along = new THREE.Vector3().subVectors(to, from);
  const length = along.length();
  mesh.position.addVectors(from, to).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(UP, along.divideScalar(length || 1));
  mesh.scale.set(width, Math.max(length, 1e-3), width);
}

/**
 * Where a mage took off, for everyone: a ring of air blown out across the
 * floor, a soft puff, and streaks flung back the way they came.
 */
class GustEffect implements Effect {
  private readonly group = new THREE.Group();
  private readonly ringMaterial = glowMaterial(WIND, 0.7);
  private readonly ring = onFloor(new THREE.Mesh(new THREE.RingGeometry(0.75, 1, 32), this.ringMaterial));
  private readonly puff = glowSprite(WIND, 0.6);
  private readonly streaks: { mesh: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>; dir: THREE.Vector3; height: number }[] = [];
  private elapsed = 0;

  constructor(parent: THREE.Object3D, x: number, y: number, yaw: number) {
    toWorld(x, y, this.group.position);
    this.puff.position.y = CHEST;
    this.group.add(this.ring, this.puff);
    // Backwards from the leap — forward is (-sin, -cos) — fanned a little either way.
    const geometry = streakGeometry();
    for (let i = 0; i < GUST_STREAKS; i++) {
      const angle = yaw + ((i / (GUST_STREAKS - 1)) - 0.5) * 1.4;
      const dir = new THREE.Vector3(Math.sin(angle), 0, Math.cos(angle));
      const mesh = new THREE.Mesh(geometry, glowMaterial(WIND, 0.8));
      this.group.add(mesh);
      this.streaks.push({ mesh, dir, height: 0.2 + Math.random() * 1.4 });
    }
    parent.add(this.group);
  }

  update(dt: number) {
    const t = (this.elapsed += dt);
    const k = Math.min(t / GUST_S, 1);
    const out = 1 - (1 - k) ** 3;
    this.ring.scale.setScalar(0.3 + GUST_RADIUS * out);
    this.ringMaterial.opacity = 0.7 * (1 - k);
    this.puff.scale.setScalar(1 + 2 * out);
    this.puff.material.opacity = 0.6 * (1 - k);
    const from = new THREE.Vector3();
    const to = new THREE.Vector3();
    for (const { mesh, dir, height } of this.streaks) {
      from.copy(dir).multiplyScalar(0.3 + 1.8 * out).setY(height);
      to.copy(dir).multiplyScalar(0.6 + 2.6 * out).setY(height);
      placeStreak(mesh, from, to, 0.025);
      mesh.material.opacity = 0.8 * (1 - k);
    }
    return k < 1;
  }

  dispose() {
    disposeGroup(this.group);
  }
}

/**
 * Wind streaks left behind a leaping remote body, for everyone: while it
 * moves fast, each frame lays streaks from where it was to where it is,
 * which then fade. `position` is where the body is drawn now; null once it's gone.
 */
class TrailEffect implements Effect {
  private readonly group = new THREE.Group();
  private readonly geometry = streakGeometry();
  private readonly streaks: { mesh: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>; age: number }[] = [];
  private last: THREE.Vector3 | null = null;
  private elapsed = 0;

  constructor(parent: THREE.Object3D, private readonly position: () => THREE.Vector3 | null) {
    parent.add(this.group);
  }

  update(dt: number) {
    this.elapsed += dt;
    const at = this.elapsed < TRAIL_WINDOW_S ? this.position() : null;
    if (at && this.last && dt > 0 && at.distanceTo(this.last) / dt >= TRAIL_MIN_SPEED) { this.lay(this.last, at); }
    this.last = at && at.clone();

    for (const streak of [...this.streaks]) {
      streak.age += dt;
      const k = streak.age / TRAIL_S;
      if (k < 1) {
        streak.mesh.material.opacity = 0.55 * (1 - k);
        continue;
      }
      streak.mesh.removeFromParent();
      streak.mesh.material.dispose();
      this.streaks.splice(this.streaks.indexOf(streak), 1);
    }
    return this.elapsed < TRAIL_WINDOW_S || this.streaks.length > 0;
  }

  /** Streaks from `from` to `to`, at a few heights and a little to either side. */
  private lay(from: THREE.Vector3, to: THREE.Vector3) {
    const side = new THREE.Vector3(to.z - from.z, 0, from.x - to.x).normalize();
    TRAIL_HEIGHTS.forEach((height, i) => {
      const offset = side.clone().multiplyScalar((i - 1) * TRAIL_SPREAD + (Math.random() - 0.5) * 0.1);
      const mesh = new THREE.Mesh(this.geometry, glowMaterial(WIND, 0.55));
      placeStreak(mesh, from.clone().add(offset).setY(from.y + height), to.clone().add(offset).setY(to.y + height), TRAIL_WIDTH);
      this.group.add(mesh);
      this.streaks.push({ mesh, age: 0 });
    });
  }

  dispose() {
    disposeGroup(this.group);
    // Shared by streaks that faded already, too.
    this.geometry.dispose();
  }
}

/** Where a leap ran into someone, for everyone: a burst of air off them and a ring blown out round their feet. */
class HitEffect implements Effect {
  private readonly group = new THREE.Group();
  private readonly puff = glowSprite(0xffffff, 0.8);
  private readonly glow = glowSprite(WIND, 0.7);
  private readonly ringMaterial = glowMaterial(WIND, 0.6);
  private readonly ring = onFloor(new THREE.Mesh(new THREE.RingGeometry(0.8, 1, 28), this.ringMaterial));
  private elapsed = 0;

  /** `at`: the victim's feet, in world units. */
  constructor(parent: THREE.Object3D, at: THREE.Vector3) {
    this.group.position.copy(at);
    this.puff.position.y = this.glow.position.y = CHEST;
    this.group.add(this.puff, this.glow, this.ring);
    parent.add(this.group);
  }

  update(dt: number) {
    const k = Math.min((this.elapsed += dt) / HIT_S, 1);
    const out = 1 - (1 - k) ** 2;
    this.puff.scale.setScalar(0.6 + 1.2 * out);
    this.puff.material.opacity = 0.8 * (1 - k);
    this.glow.scale.setScalar(1 + 2.2 * out);
    this.glow.material.opacity = 0.7 * (1 - k);
    this.ring.scale.setScalar(0.4 + 1.3 * out);
    this.ringMaterial.opacity = 0.6 * (1 - k);
    return k < 1;
  }

  dispose() {
    disposeGroup(this.group);
  }
}

/**
 * Client side of Leap: its slot's key dashes along the view at once — no
 * aiming, no click — then the cooldown display. Also draws everyone's leaps
 * from the server's messages: a gust where they took off, wind streaks
 * trailing behind remote bodies, a burst of air on whoever they run into, and
 * streaks rushing past the edges of our own view while we leap. The key goes
 * into our next input (`actions`), which slides us from that very step —
 * predicted, as the server starts it on the same step. The server decides
 * everything that matters (cooldown, the slide, the hits, the boost). `slot`
 * is null when Leap isn't in our kit: then only others' leaps are drawn.
 */
export class LeapController implements SlotSkill, ArenaSkillController {
  private readonly view = new THREE.Group();
  private readonly viewStreaks: { mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>; angle: number; phase: number }[] = [];
  private viewAmount = 0;
  private viewTime = 0;
  /** performance.now() until which our own leap lasts, as the server confirmed it. */
  private leapingUntil = 0;
  /** Remote bodies as last drawn, for trails to follow. */
  private avatars: ReadonlyMap<string, Avatar> = new Map();
  private alive = true;
  /** performance.now() when the next cast is allowed; Infinity while awaiting confirmation. */
  private readyAt = 0;
  private cooldownEndsAt = 0;
  private confirmTimer = 0;

  constructor(
    private readonly room: ArenaRoom,
    private readonly scene: ArenaScene,
    private readonly effects: Effects,
    private readonly slot: AbilitySlotUi | null,
    private readonly actions: ActionPrediction,
  ) {
    // Thin streaks round the edges of our view, each pointing out from its centre.
    for (let i = 0; i < VIEW_STREAKS; i++) {
      const angle = (i / VIEW_STREAKS) * Math.PI * 2 + Math.random() * 0.2;
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.0025, 0.07), glowMaterial(WIND, 0));
      this.view.add(mesh);
      this.viewStreaks.push({ mesh, angle, phase: Math.random() });
    }
    this.view.visible = false;
    scene.camera.add(this.view);

    room.onMessage(SERVER_MESSAGE.leapCast, (msg: LeapCast) => {
      this.effects.add(new GustEffect(scene.scene, msg.x, msg.y, msg.yaw));
      if (msg.casterId !== room.sessionId) {
        this.effects.add(new TrailEffect(scene.scene, () => this.avatars.get(msg.casterId)?.group.position ?? null));
        return;
      }
      // Already sliding and cooling down since the key: the room took it.
      clearTimeout(this.confirmTimer);
    });

    // Drawn where the victim's body is drawn now. Not on us: it would burst
    // right under our eyes, and the health bar already says it.
    room.onMessage(SERVER_MESSAGE.leapHit, (msg: LeapHit) => {
      const at = this.avatars.get(msg.victimId)?.group.position;
      if (at) { this.effects.add(new HitEffect(scene.scene, at)); }
    });
  }

  get ready() {
    return performance.now() >= this.readyAt;
  }

  /** Never selected: it has nothing to aim. */
  get selected() {
    return false;
  }

  /**
   * Its key: leap along the view right away, if it's ready — on our next
   * step, with that step's facing. The cooldown counts from the key, as the
   * room's does from that step (it allows for the trip). Not taken after a
   * while (refused, or lost): ready again, and the slide was put right.
   */
  toggle() {
    if (!this.slot || !this.ready || !this.alive) { return; }
    this.actions.press(INPUT_ACTION.leap);
    const now = performance.now();
    this.cooldownEndsAt = now + LEAP.cooldownMs;
    this.readyAt = this.cooldownEndsAt;
    this.leapingUntil = now + LEAP.durationMs;
    this.confirmTimer = window.setTimeout(() => {
      this.readyAt = 0;
      this.cooldownEndsAt = 0;
      this.leapingUntil = 0;
    }, CONFIRM_TIMEOUT_MS);
  }

  cancel() {}

  press() {}

  release() {}

  /** Per frame: the streaks at the edges of our view while we leap, and the slot display. */
  update(frame: ArenaFrame) {
    this.avatars = frame.avatars;
    this.alive = frame.alive;
    const leaping = frame.alive && performance.now() < this.leapingUntil;
    this.viewAmount = leaping ? Math.min(1, this.viewAmount + frame.dt / VIEW_IN_S) : Math.max(0, this.viewAmount - frame.dt / VIEW_OUT_S);
    this.viewTime += frame.dt;

    this.view.visible = this.viewAmount > 0;
    if (this.view.visible) {
      for (const streak of this.viewStreaks) {
        // Each rushes outward past the screen's edge, then starts over further in.
        const s = (streak.phase + this.viewTime * 3.5) % 1;
        const r = 0.8 + 0.55 * s;
        const x = Math.cos(streak.angle) * 0.36 * r;
        const y = Math.sin(streak.angle) * 0.22 * r;
        streak.mesh.position.set(x, y, -VIEW_DISTANCE);
        streak.mesh.rotation.z = Math.atan2(y, x) - Math.PI / 2;
        streak.mesh.material.opacity = 0.75 * this.viewAmount * Math.sin(Math.PI * s);
      }
    }

    this.showSlot();
  }

  private showSlot() {
    if (!this.slot) { return; }
    const remaining = Math.max(0, this.cooldownEndsAt - performance.now());
    this.slot.root.classList.toggle("cooling", remaining > 0);
    this.slot.root.style.setProperty("--cooldown", String(Math.min(1, remaining / LEAP.cooldownMs)));
    this.slot.cooldownText.textContent = remaining > 0 ? (remaining / 1000).toFixed(1) : "";
  }

  /** A fresh round (`arenaReset`): ready right away, and no leap in progress; the arena clears the effects. */
  reset() {
    clearTimeout(this.confirmTimer);
    this.readyAt = 0;
    this.cooldownEndsAt = 0;
    this.leapingUntil = 0;
    this.viewAmount = 0;
    this.view.visible = false;
  }

  dispose() {
    this.reset();
    disposeGroup(this.view);
    this.showSlot();
  }
}
