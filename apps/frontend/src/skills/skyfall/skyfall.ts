import * as THREE from "three";
import type { Player } from "@ligma/backend/rooms/schema/MyRoomState";
import {
  SKYFALL, clampSkyfallTarget, type GroundPoint, type SkyfallDrop, type SkyfallLand, type SkyfallRise,
} from "@ligma/backend/skills/skyfall/skyfallConfig";
import { PLAYER_HALF, PLAYER_HEIGHT } from "@ligma/backend/shared/constants";
import { SERVER_MESSAGE } from "@ligma/backend/shared/messages";
import { INPUT_ACTION } from "@ligma/backend/shared/actions";
import { type ArenaScene, type Avatar, toWorld, WORLD_SCALE } from "../../render/scene";
import { type Effect, Effects, glowMaterial, glowSprite, onFloor, disposeGroup } from "../../render/effects";
import type { ArenaRoom } from "../../net/arenaRoom";
import type { ActionPrediction } from "../../net/actionPrediction";
import type { AbilitySlotUi } from "../../hud/hud";
import type { SlotSkill } from "../slotSkill";
import type { ArenaFrame, ArenaSkillController } from "../arenaFrame";

/** The effect this draws, by its server id. */
const SOARING_EFFECT = "soaring";
/** If the server doesn't confirm a cast this fast, treat it as refused. */
const CONFIRM_TIMEOUT_MS = 1500;

/** Who the landing catches, in world units: the server's radius. */
const RADIUS = SKYFALL.radius * WORLD_SCALE;
const RANGE = SKYFALL.dropRange * WORLD_SCALE;
const BODY_RADIUS = PLAYER_HALF * WORLD_SCALE;
const BODY_HEIGHT = PLAYER_HEIGHT * WORLD_SCALE;

const WIND = 0xbff5ea;
const WIND_DEEP = 0x5fd6c0;
const DUST = 0xb8a88f;

/** The take-off gust: wisps spiralling up the column, and how long it lasts (s). */
const GUST_WISPS = 36;
const GUST_S = 1.1;
/** Wind riding under a soaring body: wisps circling, how fast they go round (rad/s). */
const SWIRL_WISPS = 10;
const SWIRL_SPIN = 7;
/** The wind trail behind a body on its way down: puffs dropped per second, how long each lives (s). */
const TRAIL_RATE = 60;
const TRAIL_LIFE = 0.45;
/** The landing: how fast the shockwave runs out (s), and how much dust it kicks up. */
const WAVE_S = 0.35;
const LAND_S = 1.1;
const DUST_PUFFS = 22;

/**
 * While we soar, local only: how far the drop can go around the point below
 * us, and a ring on the floor where we would land (pulled into range).
 */
class AimPreview {
  readonly group = new THREE.Group();
  private readonly range = onFloor(new THREE.Mesh(new THREE.RingGeometry(RANGE - 0.12, RANGE, 96), glowMaterial(WIND_DEEP, 0.2)));
  private readonly ringMaterial = glowMaterial(WIND, 0.7);
  private readonly ring = onFloor(new THREE.Mesh(new THREE.RingGeometry(RADIUS * 0.92, RADIUS, 64), this.ringMaterial), 0.05);
  private readonly disc = onFloor(new THREE.Mesh(new THREE.CircleGeometry(RADIUS, 48), glowMaterial(WIND_DEEP, 0.12)), 0.04);
  private readonly cross = onFloor(new THREE.Mesh(new THREE.RingGeometry(0.15, 0.35, 24), glowMaterial(WIND, 0.8)), 0.05);
  private elapsed = 0;

  constructor(parent: THREE.Object3D) {
    this.group.add(this.range, this.ring, this.disc, this.cross);
    this.group.visible = false;
    parent.add(this.group);
  }

  show(dt: number, origin: GroundPoint, target: GroundPoint | null) {
    this.group.visible = target !== null;
    if (!target) { return; }
    const t = (this.elapsed += dt);
    const at = clampSkyfallTarget(origin, target);
    toWorld(origin.x, origin.y, this.range.position).setY(0.03);
    for (const mesh of [this.ring, this.disc, this.cross]) {
      const height = mesh.position.y;
      toWorld(at.x, at.y, mesh.position).setY(height);
    }
    this.ringMaterial.opacity = 0.55 + 0.3 * Math.sin(t * 8);
  }

  dispose() {
    disposeGroup(this.group);
  }
}

/**
 * What everyone sees at take-off: a whirl of wind on the floor and wisps
 * spiralling up a column into the sky after the caster.
 */
class GustEffect implements Effect {
  private readonly group = new THREE.Group();
  private readonly floor = glowMaterial(WIND, 0.7);
  private readonly floorMesh: THREE.Mesh;
  private readonly wisps = Array.from({ length: GUST_WISPS }, (_, i) => {
    const sprite = glowSprite(i % 3 === 0 ? WIND_DEEP : WIND);
    this.group.add(sprite);
    return { sprite, angle: Math.random() * Math.PI * 2, delay: Math.random() * 0.35, speed: 0.7 + Math.random() * 0.6 };
  });
  private elapsed = 0;

  constructor(parent: THREE.Object3D, x: number, y: number, private readonly height: number) {
    toWorld(x, y, this.group.position);
    this.floorMesh = onFloor(new THREE.Mesh(new THREE.RingGeometry(RADIUS * 0.3, RADIUS * 0.45, 48), this.floor), 0.05);
    this.group.add(this.floorMesh);
    parent.add(this.group);
  }

  update(dt: number) {
    const t = (this.elapsed += dt);
    const k = Math.min(t / GUST_S, 1);

    // The whirl on the floor: spins out and fades.
    this.floorMesh.rotation.z += dt * 10;
    this.floorMesh.scale.setScalar(1 + 1.5 * k);
    this.floor.opacity = 0.7 * (1 - k);

    // Wisps: corkscrew up the column, narrowing as they climb, fading out at the top.
    for (const wisp of this.wisps) {
      const life = Math.max(0, Math.min((t - wisp.delay) * wisp.speed / 0.8, 1));
      const up = this.height * (1 - (1 - life) ** 2);
      const angle = wisp.angle + life * 14;
      const out = BODY_RADIUS * (2.6 - 1.6 * life);
      wisp.sprite.visible = life > 0 && life < 1;
      wisp.sprite.position.set(Math.cos(angle) * out, up, Math.sin(angle) * out);
      wisp.sprite.scale.setScalar(0.35 + 0.5 * (1 - life));
      wisp.sprite.material.opacity = 0.8 * Math.sin(Math.PI * life);
    }
    return t < GUST_S;
  }

  dispose() {
    disposeGroup(this.group);
  }
}

/**
 * Wind riding under a remote soaring body, hung on their avatar so it goes
 * wherever it is drawn: wisps circling under the feet and a spinning ring of
 * air, fading in and out with the `soaring` effect.
 */
class Swirl {
  readonly group = new THREE.Group();
  private readonly ringMaterial = glowMaterial(WIND, 0);
  private readonly rings = [0.9, 1.4].map((scale) => {
    const mesh = onFloor(new THREE.Mesh(new THREE.RingGeometry(BODY_RADIUS * scale * 1.6, BODY_RADIUS * scale * 2, 32, 1, 0, Math.PI * 1.4), this.ringMaterial), -0.1 * scale);
    this.group.add(mesh);
    return mesh;
  });
  private readonly wisps = Array.from({ length: SWIRL_WISPS }, (_, i) => {
    const sprite = glowSprite(i % 2 ? WIND : WIND_DEEP);
    this.group.add(sprite);
    return { sprite, angle: (i / SWIRL_WISPS) * Math.PI * 2, drop: Math.random() };
  });
  /** 0 → 1 while soaring, 1 → 0 once down. */
  private amount = 0;
  soaring = false;

  constructor(parent: THREE.Object3D) {
    parent.add(this.group);
  }

  /** False once it has faded away entirely. */
  update(dt: number) {
    this.amount = this.soaring ? Math.min(1, this.amount + dt / 0.2) : Math.max(0, this.amount - dt / 0.3);
    this.rings.forEach((ring, i) => { ring.rotation.z += dt * SWIRL_SPIN * (i ? -0.7 : 1); });
    this.ringMaterial.opacity = 0.45 * this.amount;
    for (const wisp of this.wisps) {
      wisp.angle += dt * SWIRL_SPIN;
      wisp.drop = (wisp.drop + dt * 1.5) % 1;
      const out = BODY_RADIUS * (1.4 + 0.8 * wisp.drop);
      wisp.sprite.position.set(Math.cos(wisp.angle) * out, -wisp.drop * 0.9, Math.sin(wisp.angle) * out);
      wisp.sprite.scale.setScalar(0.3 + 0.2 * (1 - wisp.drop));
      wisp.sprite.material.opacity = 0.7 * this.amount * (1 - wisp.drop);
    }
    this.group.visible = this.amount > 0;
    return this.soaring || this.amount > 0;
  }

  dispose() {
    disposeGroup(this.group);
  }
}

/** One puff of the trail: where it was left, how old it is. */
interface Puff { sprite: THREE.Sprite; age: number; }

/**
 * Behind a remote body on its way down: puffs of wind left along the path
 * as it plunges, swelling and fading. `follow` says where the body is now
 * (world units), or null once it's gone.
 */
class TrailEffect implements Effect {
  private readonly group = new THREE.Group();
  private readonly puffs: Puff[] = [];
  private elapsed = 0;
  private owed = 0;
  private done = false;

  constructor(parent: THREE.Object3D, private readonly follow: () => THREE.Vector3 | null, private readonly duration: number) {
    parent.add(this.group);
  }

  /** It landed: no more puffs; the ones left fade out. */
  finish() {
    this.done = true;
  }

  update(dt: number) {
    const t = (this.elapsed += dt);
    const at = !this.done && t < this.duration + 0.5 ? this.follow() : null;
    if (at) {
      for (this.owed += dt * TRAIL_RATE; this.owed >= 1; this.owed--) {
        const sprite = glowSprite(Math.random() < 0.3 ? WIND_DEEP : WIND);
        sprite.position.set(at.x + (Math.random() - 0.5) * 0.4, at.y + BODY_HEIGHT * (0.2 + Math.random() * 0.8), at.z + (Math.random() - 0.5) * 0.4);
        this.group.add(sprite);
        this.puffs.push({ sprite, age: 0 });
      }
    }
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const puff = this.puffs[i];
      const life = (puff.age += dt) / TRAIL_LIFE;
      if (life >= 1) {
        puff.sprite.removeFromParent();
        puff.sprite.material.dispose();
        this.puffs.splice(i, 1);
        continue;
      }
      puff.sprite.scale.setScalar(0.4 + 0.9 * life);
      puff.sprite.material.opacity = 0.6 * (1 - life);
    }
    return at !== null || this.puffs.length > 0;
  }

  dispose() {
    disposeGroup(this.group);
  }
}

/**
 * What everyone sees where a Skyfall lands: a shockwave of air racing out
 * over the floor to the edge of the hit, a gust ring after it, a flattened
 * patch, and dust kicked up and out.
 */
class LandingEffect implements Effect {
  private readonly group = new THREE.Group();
  private readonly wave = glowMaterial(WIND, 0.9);
  private readonly gust = glowMaterial(WIND_DEEP, 0.6);
  private readonly patch = new THREE.MeshBasicMaterial({ color: 0x4f4a40, transparent: true, opacity: 0, depthWrite: false });
  private readonly waveMesh = onFloor(new THREE.Mesh(new THREE.RingGeometry(0.88, 1, 64), this.wave), 0.06);
  private readonly gustMesh = onFloor(new THREE.Mesh(new THREE.RingGeometry(0.75, 1, 64), this.gust), 0.05);
  private readonly dust = Array.from({ length: DUST_PUFFS }, (_, i) => {
    const sprite = glowSprite(DUST);
    const angle = (i / DUST_PUFFS) * Math.PI * 2 + Math.random() * 0.3;
    this.group.add(sprite);
    return { sprite, dir: new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle)), reach: RADIUS * (0.7 + Math.random() * 0.5), rise: 0.6 + Math.random() * 1.2 };
  });
  private elapsed = 0;

  constructor(parent: THREE.Object3D, x: number, y: number) {
    toWorld(x, y, this.group.position);
    this.group.add(this.waveMesh, this.gustMesh, onFloor(new THREE.Mesh(new THREE.CircleGeometry(RADIUS * 0.6, 48), this.patch), 0.02));
    parent.add(this.group);
  }

  update(dt: number) {
    const t = (this.elapsed += dt);

    // The shockwave: out to the edge of the hit fast, easing off, then gone.
    const wave = Math.min(t / WAVE_S, 1);
    this.waveMesh.scale.setScalar(Math.max(0.01, RADIUS * (1 - (1 - wave) ** 3)));
    this.wave.opacity = 0.9 * (1 - wave * wave);
    const gust = Math.min(Math.max(0, t - 0.08) / (WAVE_S * 1.8), 1);
    this.gustMesh.scale.setScalar(Math.max(0.01, RADIUS * 1.15 * gust));
    this.gustMesh.rotation.z += dt * 4;
    this.gust.opacity = 0.6 * (1 - gust);
    this.patch.opacity = 0.35 * Math.min(t / 0.05, 1) * Math.max(0, 1 - Math.max(0, t - 0.4) / 0.7);

    // Dust: thrown out low and fast, billowing up and thinning out.
    const k = Math.min(t / LAND_S, 1);
    const out = 1 - (1 - k) ** 3;
    for (const puff of this.dust) {
      puff.sprite.position.copy(puff.dir).multiplyScalar(puff.reach * out).setY(0.2 + puff.rise * out);
      puff.sprite.scale.setScalar(0.6 + 1.6 * k);
      puff.sprite.material.opacity = 0.55 * (1 - k);
    }
    return t < LAND_S;
  }

  dispose() {
    disposeGroup(this.group);
  }
}

function isSoaring(player: Player) {
  return player.hp > 0 && player.effects.includes(SOARING_EFFECT);
}

/**
 * Client side of Skyfall: its slot's key launches us at once; while we soar,
 * clicks (or the key again) drop us onto the floor point we look at, within
 * range, shown by a marker only we see. Also draws everyone's: the gust at
 * take-off, the wind under soaring bodies, the trail on the way down, the
 * shockwave on landing — and the cooldown display. The server decides
 * everything that matters (cooldown, range, the flight, who gets hit); the
 * flight itself is predicted by the movement step, so the camera just follows.
 * `slot` is null when Skyfall isn't in our kit: then only others' are drawn.
 */
export class SkyfallController implements SlotSkill, ArenaSkillController {
  private readonly preview: AimPreview;
  private readonly swirls = new Map<string, Swirl>();
  private readonly trails = new Map<string, TrailEffect>();
  /** Remote bodies, by session id, as the arena last handed them to us. */
  private avatars: ReadonlyMap<string, Avatar> = new Map();
  /** performance.now() when the next cast is allowed; Infinity while awaiting confirmation. */
  private readyAt = 0;
  private cooldownEndsAt = 0;
  private confirmTimer = 0;
  /** We are up and may choose where to drop. */
  private soaring = false;
  /** We chose; the server takes it from here. */
  private dropSent = false;

  constructor(
    private readonly room: ArenaRoom,
    private readonly scene: ArenaScene,
    private readonly effects: Effects,
    private readonly slot: AbilitySlotUi | null,
    private readonly actions: ActionPrediction,
  ) {
    this.preview = new AimPreview(scene.scene);

    room.onMessage(SERVER_MESSAGE.skyfallRise, (msg: SkyfallRise) => {
      this.effects.add(new GustEffect(scene.scene, msg.x, msg.y, msg.height * WORLD_SCALE));
      if (msg.casterId !== room.sessionId) { return; }
      // Already up and cooling down since the key: the room took it.
      clearTimeout(this.confirmTimer);
    });

    room.onMessage(SERVER_MESSAGE.skyfallDrop, (msg: SkyfallDrop) => {
      if (msg.casterId === room.sessionId) {
        this.soaring = false;
        return;
      }
      this.trails.get(msg.casterId)?.finish();
      const follow = () => this.avatars.get(msg.casterId)?.group.position ?? null;
      this.trails.set(msg.casterId, this.effects.add(new TrailEffect(scene.scene, follow, msg.durationMs / 1000)));
    });

    room.onMessage(SERVER_MESSAGE.skyfallLand, (msg: SkyfallLand) => {
      this.trails.get(msg.casterId)?.finish();
      this.trails.delete(msg.casterId);
      this.effects.add(new LandingEffect(scene.scene, msg.x, msg.y));
    });
  }

  get ready() {
    return performance.now() >= this.readyAt;
  }

  /** While we soar and haven't chosen yet: clicks drop us rather than use the main skill. */
  get selected() {
    return this.soaring && !this.dropSent;
  }

  /**
   * Its key: take off right away if it's ready — on our next step, predicted
   * (`actions`), as the room starts it on the same one; up there, drop where
   * we look. The cooldown counts from the key. Not taken after a while
   * (refused, or lost): ready again, and the flight was put right.
   */
  toggle() {
    if (this.selected) {
      this.dropAtAim();
      return;
    }
    if (!this.slot || this.soaring || !this.ready) { return; }
    this.actions.press(INPUT_ACTION.skyfall);
    this.cooldownEndsAt = performance.now() + SKYFALL.cooldownMs;
    this.readyAt = this.cooldownEndsAt;
    this.soaring = true;
    this.dropSent = false;
    this.confirmTimer = window.setTimeout(() => {
      this.readyAt = 0;
      this.cooldownEndsAt = 0;
      this.soaring = false;
    }, CONFIRM_TIMEOUT_MS);
  }

  /**
   * Nothing to stop: once up, we stay up and may still click to drop (and
   * the server drops us on its own when the soar runs out). Death is noticed
   * in `update`.
   */
  cancel() {}

  /** Click: drop onto the floor point we look at. */
  press() {
    if (this.selected) { this.dropAtAim(); }
  }

  release() {}

  /**
   * Onto the crosshair's floor point, or the edge of the range ahead when
   * looking past it or at the sky (the server pulls it into range too).
   */
  private dropAtAim() {
    const target = this.scene.groundTarget(SKYFALL.dropRange);
    if (!target) { return; }
    // With our next input: the drop leaps on the very step the room's does, predicted.
    this.actions.press(INPUT_ACTION.skyfallDrop, target);
    this.dropSent = true;
  }

  /** Per frame, after avatars are placed: our aim marker, the wind under everyone soaring, the slot. */
  update(frame: ArenaFrame) {
    this.avatars = frame.avatars;
    if (!frame.alive) { this.soaring = false; }
    this.preview.show(frame.dt, frame.self, this.selected && frame.locked ? this.scene.groundTarget(SKYFALL.dropRange) : null);

    for (const [sessionId, player] of frame.players) {
      if (sessionId === this.room.sessionId) { continue; }
      const avatar = frame.avatars.get(sessionId);
      let swirl = this.swirls.get(sessionId);
      if (avatar && !swirl && isSoaring(player)) {
        swirl = new Swirl(avatar.group);
        this.swirls.set(sessionId, swirl);
      }
      if (swirl) { swirl.soaring = isSoaring(player); }
    }
    for (const [sessionId, swirl] of this.swirls) {
      if (!frame.avatars.has(sessionId) || !swirl.update(frame.dt)) {
        swirl.dispose();
        this.swirls.delete(sessionId);
      }
    }

    this.showSlot();
  }

  private showSlot() {
    if (!this.slot) { return; }
    this.slot.root.classList.toggle("armed", this.selected);
    const remaining = Math.max(0, this.cooldownEndsAt - performance.now());
    this.slot.root.classList.toggle("cooling", remaining > 0);
    this.slot.root.style.setProperty("--cooldown", String(Math.min(1, remaining / SKYFALL.cooldownMs)));
    this.slot.cooldownText.textContent = remaining > 0 ? (remaining / 1000).toFixed(1) : "";
  }

  /** A remote player left: the wind under them goes. */
  removePlayer(sessionId: string) {
    this.swirls.get(sessionId)?.dispose();
    this.swirls.delete(sessionId);
    this.trails.get(sessionId)?.finish();
    this.trails.delete(sessionId);
  }

  /**
   * A fresh round (`arenaReset`): ready right away, nobody up. The server
   * dropped it all; the visuals go with the room's `Effects`.
   */
  reset() {
    clearTimeout(this.confirmTimer);
    this.readyAt = 0;
    this.cooldownEndsAt = 0;
    this.soaring = false;
    this.dropSent = false;
    this.trails.clear();
  }

  dispose() {
    this.reset();
    this.preview.dispose();
    this.swirls.forEach((swirl) => swirl.dispose());
    this.swirls.clear();
    this.showSlot();
  }
}
