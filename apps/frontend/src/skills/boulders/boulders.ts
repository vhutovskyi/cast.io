import * as THREE from "three";
import { Callbacks } from "@colyseus/sdk";
import {
  BOULDERS, boulderPosition, distanceToBoulder,
  type BoulderHit, type BoulderKicked, type BoulderLaunch, type BoulderPoint, type BoulderRaised,
} from "@ligma/backend/skills/boulders/bouldersConfig";
import type { Obstacle } from "@ligma/backend/shared/obstacles";
import { CLIENT_MESSAGE, SERVER_MESSAGE } from "@ligma/backend/shared/messages";
import { type ArenaScene, toWorld, WORLD_SCALE } from "../../render/scene";
import { type Effect, Effects, glowMaterial, glowSprite, onFloor, disposeGroup } from "../../render/effects";
import type { ArenaRoom } from "../../net/arenaRoom";
import type { AbilitySlotUi } from "../../hud/hud";
import type { SlotSkill } from "../slotSkill";

/** If the server doesn't confirm a raise or a kick this fast, treat it as refused. */
const CONFIRM_TIMEOUT_MS = 1500;
/** A boulder bursts up out of the floor over this, and sinks back into it over that (s). */
const RISE_S = 0.25;
const SINK_S = 0.5;
/** Broken: chunks flying off it, how long they fly, how hard gravity pulls them (world units). */
const CHUNKS = 16;
const BREAK_S = 0.9;
const GRAVITY = 16;
/** Dust kicked up behind a flying boulder: how many puffs, how long each lasts (s). */
const TRAIL_PUFFS = 10;
const TRAIL_LIFE_S = 0.35;

const ROCK_COLORS = [0x7a6450, 0x6b5a48, 0x8a6d4b, 0x5e4c3c];
/** Our own boulders' outline on the floor: calm, steady, brighter while one is in kicking reach. */
const OWN_MARK_COLOR = 0x7fd18b;
const OWN_MARK_OPACITY = 0.35;
const OWN_MARK_IN_REACH = 0.8;

/** A rough rock: a low-poly ball with its corners pushed in and out a little, sized `sx` × `sy` × `sz`. */
function rockGeometry(sx: number, sy: number, sz: number) {
  const geometry = new THREE.DodecahedronGeometry(0.5, 0);
  const positions = geometry.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < positions.count; i++) {
    const k = 0.85 + Math.random() * 0.3;
    positions.setXYZ(i, positions.getX(i) * k * sx, positions.getY(i) * k * sy, positions.getZ(i) * k * sz);
  }
  geometry.computeVertexNormals();
  return geometry;
}

function rockMaterial(i: number) {
  return new THREE.MeshStandardMaterial({ color: ROCK_COLORS[i % ROCK_COLORS.length], roughness: 0.95, flatShading: true, transparent: true, opacity: 1 });
}

/** One boulder, standing: a heap of two rough rocks filling its footprint and height. */
function boulderMesh(boulder: Obstacle) {
  const group = new THREE.Group();
  const width = boulder.halfLength * 2 * WORLD_SCALE;
  const depth = boulder.halfThickness * 2 * WORLD_SCALE;
  const height = boulder.height * WORLD_SCALE;
  const base = new THREE.Mesh(rockGeometry(width * 1.15, height * 0.7, depth * 1.2), rockMaterial(0));
  base.position.y = height * 0.35;
  const top = new THREE.Mesh(rockGeometry(width * 0.9, height * 0.5, depth), rockMaterial(1));
  top.position.y = height * 0.72;
  top.rotation.y = Math.random() * 0.6 - 0.3;
  group.add(base, top);
  return group;
}

/** A point on the server's plane and height, in world space. */
function toWorldPoint(p: BoulderPoint, out: THREE.Vector3) {
  toWorld(p.x, p.y, out);
  out.y = p.z * WORLD_SCALE;
  return out;
}

/**
 * A boulder as everyone sees it, standing where it rose: bursting up out of
 * the floor with a puff of dust. Ours have an outline on the floor round
 * them, so they stand out from everyone else's.
 */
class BoulderView {
  readonly group = new THREE.Group();
  private readonly dust = glowSprite(0xb59b7c);
  private readonly mark: THREE.MeshBasicMaterial | null;
  private elapsed = 0;

  constructor(parent: THREE.Object3D, readonly boulder: Obstacle, own: boolean) {
    this.group.add(boulderMesh(boulder), this.dust);
    this.mark = own ? glowMaterial(OWN_MARK_COLOR, OWN_MARK_OPACITY) : null;
    if (this.mark) {
      // A rounded outline just outside the footprint, flat on the floor.
      const reach = Math.max(boulder.halfLength, boulder.halfThickness) * WORLD_SCALE * 1.5;
      const ring = onFloor(new THREE.Mesh(new THREE.RingGeometry(reach * 0.88, reach, 40), this.mark), 0.04);
      ring.scale.set(1, boulder.halfThickness / boulder.halfLength, 1);
      this.group.add(ring);
    }
    this.dust.position.y = 0.3;
    this.dust.scale.setScalar(boulder.halfLength * 4 * WORLD_SCALE);
    toWorld(boulder.x, boulder.y, this.group.position);
    // The simulation's +y is the world's +z, so its turn runs the other way.
    this.group.rotation.y = -boulder.angle;
    parent.add(this.group);
  }

  /** `inReach`: ours, and close enough to kick. */
  update(dt: number, inReach: boolean) {
    const t = (this.elapsed += dt);
    const rise = Math.min(t / RISE_S, 1);
    this.group.position.y = -this.boulder.height * WORLD_SCALE * (1 - rise) ** 3;
    if (this.mark) { this.mark.opacity = inReach ? OWN_MARK_IN_REACH : OWN_MARK_OPACITY; }
    this.dust.material.opacity = 0.5 * Math.max(0, 1 - t / 0.6);
  }

  dispose() {
    disposeGroup(this.group);
  }
}

/** A boulder that ran out of time: sinking back into the floor, fading. */
class SinkEffect implements Effect {
  private elapsed = 0;

  constructor(private readonly view: BoulderView) {}

  update(dt: number) {
    const k = Math.min((this.elapsed += dt) / SINK_S, 1);
    this.view.group.position.y = -this.view.boulder.height * WORLD_SCALE * k * k;
    this.view.group.traverse((child) => {
      if (child instanceof THREE.Mesh) { (child.material as THREE.MeshStandardMaterial).opacity = 1 - k; }
    });
    return k < 1;
  }

  dispose() {
    this.view.dispose();
  }
}

/** A kicked boulder breaking, for everyone: chunks of rock flying and a burst of dust. */
class BreakEffect implements Effect {
  private readonly group = new THREE.Group();
  private readonly dust = glowSprite(0xb59b7c, 0.7);
  private readonly chunks: { mesh: THREE.Mesh; material: THREE.MeshStandardMaterial; velocity: THREE.Vector3; spin: THREE.Vector3 }[] = [];
  private elapsed = 0;

  constructor(parent: THREE.Object3D, at: BoulderPoint) {
    toWorldPoint(at, this.group.position);
    this.group.add(this.dust);
    for (let i = 0; i < CHUNKS; i++) {
      const size = 0.15 + Math.random() * 0.25;
      const material = rockMaterial(i);
      const mesh = new THREE.Mesh(rockGeometry(size, size, size), material);
      const angle = Math.random() * Math.PI * 2;
      const out = 2 + Math.random() * 4;
      this.group.add(mesh);
      this.chunks.push({
        mesh, material,
        velocity: new THREE.Vector3(Math.cos(angle) * out, 2 + Math.random() * 4, Math.sin(angle) * out),
        spin: new THREE.Vector3(Math.random() * 8, Math.random() * 8, Math.random() * 8),
      });
    }
    parent.add(this.group);
  }

  update(dt: number) {
    const t = (this.elapsed += dt);
    const k = Math.min(t / BREAK_S, 1);
    this.dust.scale.setScalar(1 + 2.5 * k);
    this.dust.material.opacity = 0.7 * (1 - k);
    const floor = -this.group.position.y;
    for (const chunk of this.chunks) {
      chunk.velocity.y -= GRAVITY * dt;
      chunk.mesh.position.addScaledVector(chunk.velocity, dt);
      if (chunk.mesh.position.y < floor) {
        chunk.mesh.position.y = floor;
        chunk.velocity.set(chunk.velocity.x * 0.5, 0, chunk.velocity.z * 0.5);
      }
      chunk.mesh.rotation.x += chunk.spin.x * dt;
      chunk.mesh.rotation.z += chunk.spin.z * dt;
      chunk.material.opacity = 1 - Math.max(0, k - 0.6) / 0.4;
    }
    return k < 1;
  }

  dispose() {
    disposeGroup(this.group);
  }
}

/** A kicked boulder in flight, flown here along the server's line from the kick; dust trailing behind it. */
class Flying {
  readonly group = new THREE.Group();
  private readonly puffs = Array.from({ length: TRAIL_PUFFS }, () => ({ sprite: glowSprite(0xb59b7c), age: Infinity }));
  private next = 0;
  private sinceDrop = 0;
  private readonly spinAxis: THREE.Vector3;
  private readonly startedAt = performance.now();
  private lastFrame = this.startedAt;

  constructor(private readonly parent: THREE.Object3D, readonly launch: BoulderLaunch, boulder: Obstacle) {
    this.group.add(boulderMesh({ ...boulder, height: BOULDERS.radius * 2 }));
    // Rolls over and over along the way it goes.
    this.spinAxis = new THREE.Vector3(launch.vy, 0, -launch.vx).normalize();
    parent.add(this.group);
    for (const { sprite } of this.puffs) { parent.add(sprite); }
  }

  /** False once it has flown its lifetime without breaking. */
  update(now: number) {
    const age = (now - this.startedAt) / 1000;
    if (age * 1000 >= BOULDERS.flyLifetimeMs) { return false; }
    const dt = Math.max(0, (now - this.lastFrame) / 1000);
    this.lastFrame = now;

    toWorldPoint(boulderPosition(this.launch, age), this.group.position);
    this.group.position.y -= BOULDERS.radius * WORLD_SCALE;
    this.group.rotateOnWorldAxis(this.spinAxis, -dt * 10);

    this.sinceDrop += dt;
    if (this.sinceDrop >= TRAIL_LIFE_S / TRAIL_PUFFS) {
      this.sinceDrop = 0;
      const puff = this.puffs[this.next];
      this.next = (this.next + 1) % TRAIL_PUFFS;
      puff.age = 0;
      puff.sprite.position.copy(this.group.position).setY(0.25);
    }
    for (const puff of this.puffs) {
      puff.age += dt;
      const k = puff.age / TRAIL_LIFE_S;
      puff.sprite.visible = k < 1;
      puff.sprite.scale.setScalar(0.5 + 1.2 * Math.min(k, 1));
      puff.sprite.material.opacity = 0.5 * Math.max(0, 1 - k);
    }
    return true;
  }

  dispose() {
    disposeGroup(this.group);
    this.puffs.forEach(({ sprite }) => {
      sprite.removeFromParent();
      sprite.material.dispose();
    });
  }
}

/**
 * Client side of Boulders: its slot's key raises a boulder just ahead of you
 * (up to `BOULDERS.maxStanding` of yours at once) — or, standing at one of
 * yours, kicks it along your facing; so does a plain left click there
 * (`kickByClick`), instead of the main skill. Ours are outlined on the floor. Draws every
 * boulder standing — from the synced `state.walls` — rising, sinking back
 * when its time is up, flying once kicked and breaking where it hits. The
 * server decides everything that matters (when, where, what it hits). `slot`
 * is null when Boulders isn't in our kit: then only the boulders are drawn.
 */
export class BouldersController implements SlotSkill {
  private readonly views = new Map<string, BoulderView>();
  private readonly flying = new Map<string, Flying>();
  /** Kicked boulders whose kick arrived before the patch taking them out of the state. */
  private readonly kicked = new Set<string>();
  /** performance.now() when the next raise is allowed; Infinity while awaiting confirmation. */
  private readyAt = 0;
  private cooldownEndsAt = 0;
  private cooldownMs: number = BOULDERS.raiseIntervalMs;
  private confirmTimer = 0;
  /** A kick sent and not yet answered: no second one meanwhile. */
  private kickSentAt = -Infinity;
  /** Where we see ourselves and which way we face, from the last frame. */
  private origin = { x: 0, y: 0 };
  private yaw = 0;

  constructor(
    private readonly room: ArenaRoom,
    private readonly scene: ArenaScene,
    private readonly effects: Effects,
    private readonly slot: AbilitySlotUi | null,
  ) {
    const callbacks = Callbacks.get(room);
    callbacks.onAdd("walls", (wall, id) => {
      if (wall.kind !== "boulder") { return; }
      this.views.get(id)?.dispose();
      this.views.set(id, new BoulderView(scene.scene, wall, wall.ownerId === room.sessionId));
    });
    callbacks.onRemove("walls", (wall, id) => {
      if (wall.kind !== "boulder") { return; }
      const view = this.views.get(id);
      this.views.delete(id);
      if (!view) { return; }
      // Kicked: it is already flying. Otherwise its time ran out.
      if (this.kicked.delete(id)) { view.dispose(); } else { this.effects.add(new SinkEffect(view)); }
    });

    room.onMessage(SERVER_MESSAGE.boulderRaised, (msg: BoulderRaised) => {
      clearTimeout(this.confirmTimer);
      // Counting from arrival keeps us a little *behind* the server's own
      // timer, so a raise is never sent early and silently refused.
      this.cooldownMs = msg.raiseIntervalMs;
      this.cooldownEndsAt = performance.now() + msg.raiseIntervalMs;
      this.readyAt = this.cooldownEndsAt;
    });

    room.onMessage(SERVER_MESSAGE.boulderKicked, (msg: BoulderKicked) => {
      if (msg.casterId === room.sessionId) { this.kickSentAt = -Infinity; }
      // Usually ahead of the patch that takes it out of the state.
      const view = this.views.get(msg.id);
      const shape = view?.boulder ?? { x: msg.x, y: msg.y, angle: 0, halfLength: BOULDERS.halfWidth, halfThickness: BOULDERS.halfDepth, height: BOULDERS.height };
      if (view) {
        this.views.delete(msg.id);
        view.dispose();
      } else {
        this.kicked.add(msg.id);
      }
      this.flying.set(msg.id, new Flying(scene.scene, msg, shape));
    });

    room.onMessage(SERVER_MESSAGE.boulderHit, (msg: BoulderHit) => {
      this.flying.get(msg.id)?.dispose();
      this.flying.delete(msg.id);
      this.effects.add(new BreakEffect(scene.scene, msg));
    });
  }

  get ready() {
    return performance.now() >= this.readyAt;
  }

  /** Never selected: it has nothing to aim. */
  get selected() {
    return false;
  }

  /** Our boulders standing right now, by id. */
  private ours() {
    return [...this.room.state.walls].filter(([, wall]) => wall.kind === "boulder" && wall.ownerId === this.room.sessionId);
  }

  /** The one of ours we stand at — close enough to kick — if any; the nearest, if two. */
  private kickable(): string | undefined {
    let nearest: { id: string; distance: number } | undefined;
    for (const [id, wall] of this.ours()) {
      const distance = distanceToBoulder(wall, this.origin);
      if (distance > BOULDERS.kickReach) { continue; }
      if (!nearest || distance < nearest.distance) { nearest = { id, distance }; }
    }
    return nearest?.id;
  }

  /**
   * A left click with no other skill selected: kicks the boulder we stand
   * at, instead of using the main skill. False if there is none in reach
   * (or Boulders isn't ours), so the click goes on to the main skill.
   */
  kickByClick(): boolean {
    if (!this.slot || !this.kickable()) { return false; }
    this.kick();
    return true;
  }

  /** Sends the kick, once until it's answered. */
  private kick() {
    const now = performance.now();
    if (now - this.kickSentAt < CONFIRM_TIMEOUT_MS) { return; }
    this.room.send(CLIENT_MESSAGE.boulderKick, { yaw: this.yaw });
    this.kickSentAt = now;
  }

  /** Its key: kick the boulder we stand at, if any; otherwise raise one, if we may. */
  toggle() {
    if (!this.slot) { return; }
    if (this.kickable()) {
      this.kick();
      return;
    }
    if (!this.ready || this.ours().length >= BOULDERS.maxStanding) { return; }
    this.room.send(CLIENT_MESSAGE.boulderRaise);
    // No double-sends while the server decides; give up waiting after a while.
    this.readyAt = Infinity;
    clearTimeout(this.confirmTimer);
    this.confirmTimer = window.setTimeout(() => { this.readyAt = 0; }, CONFIRM_TIMEOUT_MS);
  }

  cancel() {}

  press() {}

  release() {}

  /**
   * Per frame: every boulder, standing or flying, and the slot display.
   * `origin` is where we see ourselves (our predicted position) and `yaw`
   * our view's heading — what a kick goes by.
   */
  update(dt: number, origin: { x: number; y: number }, yaw: number) {
    this.origin = origin;
    this.yaw = yaw;
    const now = performance.now();
    const inReach = this.kickable();
    for (const [id, view] of this.views) { view.update(dt, id === inReach); }
    for (const [id, flying] of this.flying) {
      if (!flying.update(now)) {
        flying.dispose();
        this.flying.delete(id);
      }
    }
    this.showSlot(now);
  }

  /** Lit while a kick is in reach; the count shows how many more can rise. */
  private showSlot(now: number) {
    if (!this.slot) { return; }
    this.slot.root.classList.toggle("armed", this.kickable() !== undefined);
    const remaining = Math.max(0, this.cooldownEndsAt - now);
    const left = BOULDERS.maxStanding - this.ours().length;
    this.slot.root.classList.toggle("cooling", remaining > 0 || left === 0);
    this.slot.root.style.setProperty("--cooldown", String(Math.min(1, remaining / this.cooldownMs)));
    this.slot.cooldownText.textContent = remaining > 0 ? (remaining / 1000).toFixed(1) : String(left);
  }

  /** A fresh round (`arenaReset`): ready right away. The server took every boulder down; they leave the state with it. */
  reset() {
    clearTimeout(this.confirmTimer);
    this.readyAt = 0;
    this.cooldownEndsAt = 0;
    this.kickSentAt = -Infinity;
    this.flying.forEach((flying) => flying.dispose());
    this.flying.clear();
  }

  dispose() {
    this.reset();
    this.views.forEach((view) => view.dispose());
    this.views.clear();
    this.kicked.clear();
    if (!this.slot) { return; }
    this.slot.root.classList.remove("armed", "cooling");
    this.slot.root.style.setProperty("--cooldown", "0");
    this.slot.cooldownText.textContent = "";
  }
}
