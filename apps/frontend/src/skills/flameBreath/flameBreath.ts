import * as THREE from "three";
import { FLAME_BREATH, type FlameBreathEnd } from "@ligma/backend/skills/flameBreath/flameBreathConfig";
import { TICK_RATE } from "@ligma/backend/shared/constants";
import { SERVER_MESSAGE } from "@ligma/backend/shared/messages";
import { type ArenaScene, type Avatar, WORLD_SCALE } from "../../render/scene";
import { glowSprite, disposeGroup } from "../../render/effects";
import type { ArenaRoom } from "../../net/arenaRoom";
import type { AbilitySlotUi } from "../../hud/hud";
import type { SlotSkill } from "../slotSkill";

/** The longest channel in input steps — the server counts it the same way. */
const MAX_STEPS = Math.round((FLAME_BREATH.maxChannelMs / 1000) * TICK_RATE);
/** If the server doesn't confirm the end of a channel this fast, stop waiting. */
const CONFIRM_TIMEOUT_MS = 1500;

/** How far the flames carry, in world units: the server's range. */
const RANGE = FLAME_BREATH.range * WORLD_SCALE;
/** Seconds a flame lives — it covers the range in that time. */
const FLAME_LIFE = 0.45;
const FLAME_SPEED = RANGE / FLAME_LIFE;
/** New flames per second while breathing, and the most alive at once. */
const FLAME_RATE = 100;
const MAX_FLAMES = Math.ceil(FLAME_RATE * FLAME_LIFE * 1.3);
/**
 * Random spread of a flame's heading, sideways and up/down, as a fraction of
 * its speed. Inside the server's cone sideways; flatter vertically, since the
 * flames stay level (see `FLAME_BREATH.verticalReach`).
 */
const SPREAD_SIDE = Math.tan((FLAME_BREATH.halfAngleDeg * Math.PI) / 180) * 0.75;
const SPREAD_UP = 0.18;
/** Flame size at the far end of the range, in world units. */
const END_SIZE = 2.2;
/** First person: bottom right of the view, where the fireball is held (camera space). */
const VIEW_POSITION = new THREE.Vector3(0.36, -0.28, -0.8);

const HOT = new THREE.Color(0xfff1b0);
const FIRE = new THREE.Color(0xff7a22);
const EMBER = new THREE.Color(0xa01c06);

interface Flame {
  sprite: THREE.Sprite;
  velocity: THREE.Vector3;
  age: number;
  /** Dead flames wait hidden in the pool for reuse. */
  alive: boolean;
}

/**
 * A stream of additive flame sprites pouring from `origin` along `direction`,
 * in world space — so it trails behind when the breather turns. Flames are
 * pooled; emitting stops when `active` goes false, and the rest burn out.
 */
class FlameStream {
  readonly origin = new THREE.Vector3();
  readonly direction = new THREE.Vector3(0, 0, -1);
  active = false;
  private readonly group = new THREE.Group();
  private readonly glow = glowSprite(0xffb347);
  private readonly flames: Flame[] = [];
  private readonly side = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  /** Fractional flames owed to the emission rate. */
  private owed = 0;
  private elapsed = Math.random() * 100;

  constructor(parent: THREE.Object3D, private readonly startSize: number, private readonly opacity: number) {
    this.group.add(this.glow);
    parent.add(this.group);
  }

  update(dt: number) {
    const t = (this.elapsed += dt);

    // A flickering glow at the hand while the breath lasts.
    this.glow.visible = this.active;
    this.glow.position.copy(this.origin);
    this.glow.scale.setScalar(this.startSize * (4 + 0.6 * Math.sin(t * 31) + 0.4 * Math.sin(t * 47)));
    this.glow.material.opacity = 0.8;

    if (this.active) {
      this.owed += dt * FLAME_RATE;
      for (; this.owed >= 1; this.owed--) { this.emit(); }
    } else {
      this.owed = 0;
    }

    for (const flame of this.flames) {
      if (!flame.alive) { continue; }
      flame.age += dt;
      const k = flame.age / FLAME_LIFE;
      if (k >= 1) {
        flame.alive = false;
        flame.sprite.visible = false;
        continue;
      }
      const { sprite } = flame;
      sprite.position.addScaledVector(flame.velocity, dt);
      // Swells as it travels; white-hot, then orange, then dull red as it cools.
      sprite.scale.setScalar(this.startSize + (END_SIZE - this.startSize) * k);
      if (k < 0.35) { sprite.material.color.lerpColors(HOT, FIRE, k / 0.35); }
      else { sprite.material.color.lerpColors(FIRE, EMBER, (k - 0.35) / 0.65); }
      sprite.material.opacity = this.opacity * Math.min(1, k * 16) * (1 - k) ** 1.3;
    }
  }

  private emit() {
    let flame = this.flames.find((f) => !f.alive);
    if (!flame) {
      if (this.flames.length >= MAX_FLAMES) { return; }
      flame = { sprite: glowSprite(0xffffff), velocity: new THREE.Vector3(), age: 0, alive: false };
      this.group.add(flame.sprite);
      this.flames.push(flame);
    }

    this.side.crossVectors(this.direction, this.up).normalize();
    flame.velocity.copy(this.direction)
      .addScaledVector(this.side, (Math.random() * 2 - 1) * SPREAD_SIDE)
      .addScaledVector(this.up, (Math.random() * 2 - 1) * SPREAD_UP)
      .normalize()
      .multiplyScalar(FLAME_SPEED * (0.85 + 0.3 * Math.random()));
    // Spread the births over the frame, so a low frame rate doesn't pulse.
    flame.age = Math.random() * 0.03;
    flame.sprite.position.copy(this.origin).addScaledVector(flame.velocity, flame.age);
    flame.sprite.scale.setScalar(this.startSize);
    flame.sprite.material.opacity = 0;
    flame.sprite.visible = true;
    flame.alive = true;
  }

  dispose() {
    disposeGroup(this.group);
  }
}

/** World-space heading for a yaw: at yaw 0 forward is -z, as in `stepEntity`. Level, like the server's cone. */
function yawForward(yaw: number, out: THREE.Vector3) {
  return out.set(-Math.sin(yaw), 0, -Math.cos(yaw));
}

/**
 * Client side of Flame Breath: select with its slot's key, hold the left mouse button to
 * breathe, let go (or run out of breath) to stop — then back to Fireball.
 * Breathing travels as an input flag, decided here one input step at a time;
 * the server vets it and decides everything that matters (who burns, how
 * long, the cooldown). Draws your own flames from your right hand and other
 * players' from theirs while the server says they are breathing. `slot` is
 * null when Flame Breath isn't in our kit: then only others' flames are drawn.
 */
export class FlameBreathController implements SlotSkill {
  private readonly own: FlameStream;
  private readonly hands = new Map<string, { avatar: Avatar; stream: FlameStream }>();
  /** Selected with its key — clicks breathe instead of throwing the main skill. */
  private armed = false;
  /** The left button is down on a breath. */
  private held = false;
  /** Breath inputs sent in the channel in progress; 0 when not breathing. */
  private steps = 0;
  /** performance.now() when the next breath is allowed; Infinity while awaiting the server's end. */
  private readyAt = 0;
  private cooldownEndsAt = 0;
  private awaiting = false;
  private confirmTimer = 0;

  constructor(
    private readonly room: ArenaRoom,
    private readonly scene: ArenaScene,
    private readonly slot: AbilitySlotUi | null,
  ) {
    this.own = new FlameStream(scene.scene, 0.06, 0.55);

    room.onMessage(SERVER_MESSAGE.flameBreathEnd, (msg: FlameBreathEnd) => {
      clearTimeout(this.confirmTimer);
      // Usually we stopped first and are waiting for this; if the server ended
      // it (we died, a stall), stop here too. Counting from arrival keeps us a
      // little *behind* the server's own cooldown, so a breath is never sent
      // early and silently refused.
      this.armed = false;
      this.held = false;
      this.steps = 0;
      this.awaiting = false;
      this.cooldownEndsAt = performance.now() + msg.cooldownMs;
      this.readyAt = this.cooldownEndsAt;
    });
  }

  get ready() {
    return performance.now() >= this.readyAt;
  }

  /** Whether clicks breathe; otherwise they throw the main skill. */
  get selected() {
    return this.armed;
  }

  /** Our own channel is in progress (as far as we have sent). */
  get breathing() {
    return this.steps > 0;
  }

  /** Its key: select Flame Breath, or go back to the main skill if already selected. */
  toggle() {
    if (this.armed) { this.cancel(); } else { this.armed = this.ready && this.slot !== null; }
  }

  /** Right-click, Z, X, Esc, death, leaving the room: back to the main skill. */
  cancel() {
    this.stop();
  }

  /** Left button down while selected: breathe until it comes up. */
  press() {
    if (this.armed && this.ready) { this.held = true; }
  }

  /** Left button up: the breath ends and the main skill is selected again. */
  release() {
    if (this.held) { this.stop(); }
  }

  /**
   * Per input step: whether this step breathes. Counted one input at a time,
   * exactly as the server counts the channel, so the end of breath (and the
   * slowdown it lifts) is predicted right on time.
   */
  step(): boolean {
    if (this.armed && this.held && this.ready && this.steps < MAX_STEPS) {
      this.steps++;
      return true;
    }
    if (this.steps > 0) { this.stop(); } // out of breath
    return false;
  }

  /** A remote fire mage: their flames pour from their right hand. */
  addHand(sessionId: string, avatar: Avatar) {
    this.hands.set(sessionId, { avatar, stream: new FlameStream(this.scene.scene, 0.35, 0.7) });
  }

  /** The avatar is going away. */
  removeHand(sessionId: string) {
    this.hands.get(sessionId)?.stream.dispose();
    this.hands.delete(sessionId);
  }

  /**
   * Per frame, after the camera moves: your own flames, everyone else's and
   * the slot display. `aiming` is false once the mouse is released.
   */
  update(dt: number, aiming: boolean, yaw: number) {
    if (!aiming) { this.cancel(); }

    const camera = this.scene.camera;
    camera.updateMatrixWorld();
    this.own.active = this.breathing;
    camera.localToWorld(this.own.origin.copy(VIEW_POSITION));
    yawForward(yaw, this.own.direction);
    this.own.update(dt);

    for (const [sessionId, { avatar, stream }] of this.hands) {
      const player = this.room.state.players.get(sessionId);
      stream.active = !!player?.breathing && player.hp > 0;
      avatar.hand.getWorldPosition(stream.origin);
      yawForward(player?.yaw ?? 0, stream.direction);
      stream.update(dt);
    }

    this.showSlot();
  }

  /**
   * Ends our side of a channel, if one is running, and selects the main skill.
   * No new breath until the server's end message says how long to wait.
   */
  private stop() {
    this.armed = false;
    this.held = false;
    if (this.steps === 0) { return; }
    this.steps = 0;
    this.awaiting = true;
    this.readyAt = Infinity;
    clearTimeout(this.confirmTimer);
    this.confirmTimer = window.setTimeout(() => {
      this.awaiting = false;
      this.readyAt = 0;
    }, CONFIRM_TIMEOUT_MS);
  }

  private showSlot() {
    if (!this.slot) { return; }
    this.slot.root.classList.toggle("armed", this.armed);
    const remaining = this.awaiting ? FLAME_BREATH.cooldownMs : Math.max(0, this.cooldownEndsAt - performance.now());
    this.slot.root.classList.toggle("cooling", remaining > 0);
    this.slot.root.style.setProperty("--cooldown", String(Math.min(1, remaining / FLAME_BREATH.cooldownMs)));
    this.slot.cooldownText.textContent = remaining > 0 ? (remaining / 1000).toFixed(1) : "";
  }

  /** A fresh round (`arenaReset`): the server cut every channel without a cooldown. */
  reset() {
    clearTimeout(this.confirmTimer);
    this.armed = false;
    this.held = false;
    this.steps = 0;
    this.awaiting = false;
    this.readyAt = 0;
    this.cooldownEndsAt = 0;
  }

  dispose() {
    clearTimeout(this.confirmTimer);
    this.own.dispose();
    this.hands.forEach(({ stream }) => stream.dispose());
    this.hands.clear();
    this.armed = false;
    this.held = false;
    this.steps = 0;
    this.awaiting = false;
    this.readyAt = 0;
    this.cooldownEndsAt = 0;
    this.showSlot();
  }
}
