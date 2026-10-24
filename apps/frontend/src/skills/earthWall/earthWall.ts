import * as THREE from "three";
import { Callbacks } from "@colyseus/sdk";
import {
  EARTH_WALL, placeEarthWall, type EarthWallBlast, type EarthWallRaised, type GroundPoint,
} from "@ligma/backend/skills/earthWall/earthWallConfig";
import type { Obstacle } from "@ligma/backend/shared/obstacles";
import { CLIENT_MESSAGE, SERVER_MESSAGE } from "@ligma/backend/shared/messages";
import { type ArenaScene, toWorld, WORLD_SCALE } from "../../render/scene";
import { type Effect, Effects, glowMaterial, glowSprite, onFloor, disposeGroup } from "../../render/effects";
import type { ArenaRoom } from "../../net/arenaRoom";
import type { AbilitySlotUi } from "../../hud/hud";
import type { SlotSkill } from "../slotSkill";

/** If the server doesn't confirm a cast this fast, treat it as refused. */
const CONFIRM_TIMEOUT_MS = 1500;
const RANGE = EARTH_WALL.range * WORLD_SCALE;

/** A wall bursts up out of the floor over this, and sinks back into it over that (s). */
const RISE_S = 0.25;
const SINK_S = 0.5;
/** Rough rocks along a wall's top and faces, so it reads as heaped stone, not a box. */
const ROCKS = 16;
/** Blown up: chunks flying off it, how long they fly, how hard gravity pulls them (world units). */
const CHUNKS = 26;
const BLAST_S = 1.1;
const GRAVITY = 16;

const STONE_COLORS = [0x7a6450, 0x6b5a48, 0x8a6d4b, 0x5e4c3c];

/** A rough rock: a low-poly ball with its corners pushed in and out a little. */
function rockGeometry(radius: number) {
  const geometry = new THREE.DodecahedronGeometry(radius, 0);
  const positions = geometry.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < positions.count; i++) {
    const k = 0.7 + Math.random() * 0.5;
    positions.setXYZ(i, positions.getX(i) * k, positions.getY(i) * k, positions.getZ(i) * k);
  }
  geometry.computeVertexNormals();
  return geometry;
}

function stoneMaterial(color: number) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.95, metalness: 0, flatShading: true, transparent: true, opacity: 1 });
}

/** Where a wall stands, in world space: centred on its footprint at floor level, turned along it. */
function placeGroup(group: THREE.Object3D, wall: Obstacle) {
  toWorld(wall.x, wall.y, group.position);
  // Along +x at angle 0 in the simulation, which is +x in the world; the
  // simulation's +y is the world's +z, so the turn runs the other way.
  group.rotation.set(0, -wall.angle, 0);
}

/**
 * A wall of rock as everyone sees it: a heaped slab with rough rocks on it,
 * bursting up out of the floor with a puff of dust.
 */
class WallView {
  readonly group = new THREE.Group();
  private readonly dust = glowSprite(0xb59b7c);
  private readonly height: number;
  private elapsed = 0;

  constructor(parent: THREE.Object3D, readonly wall: Obstacle) {
    const length = wall.halfLength * 2 * WORLD_SCALE;
    const thickness = wall.halfThickness * 2 * WORLD_SCALE;
    this.height = wall.height * WORLD_SCALE;

    const slab = new THREE.Mesh(new THREE.BoxGeometry(length, this.height, thickness), stoneMaterial(STONE_COLORS[0]));
    slab.position.y = this.height / 2;
    this.group.add(slab);

    for (let i = 0; i < ROCKS; i++) {
      const rock = new THREE.Mesh(rockGeometry(thickness * (0.55 + Math.random() * 0.45)), stoneMaterial(STONE_COLORS[i % STONE_COLORS.length]));
      const onTop = i % 3 === 0;
      rock.position.set(
        (Math.random() - 0.5) * length * 0.95,
        onTop ? this.height : this.height * (0.1 + 0.85 * Math.random()),
        onTop ? 0 : (i % 2 === 0 ? 1 : -1) * thickness * 0.45,
      );
      rock.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
      this.group.add(rock);
    }

    this.dust.scale.setScalar(length * 1.2);
    this.dust.position.y = 0.3;
    placeGroup(this.group, wall);
    parent.add(this.group);
    this.group.add(this.dust);
  }

  update(dt: number) {
    const t = (this.elapsed += dt);
    // Bursts up out of the floor, overshooting a little, then settles.
    const rise = Math.min(t / RISE_S, 1);
    this.group.position.y = -this.height * (1 - rise) ** 3 + (rise < 1 ? 0.15 * Math.sin(Math.PI * rise) : 0);
    this.dust.material.opacity = 0.5 * Math.max(0, 1 - t / 0.6);
  }

  dispose() {
    disposeGroup(this.group);
  }
}

/** A wall that ran out of time: sinking back into the floor, fading, a last puff of dust. */
class SinkEffect implements Effect {
  private elapsed = 0;

  constructor(private readonly view: WallView) {}

  update(dt: number) {
    const t = (this.elapsed += dt);
    const k = Math.min(t / SINK_S, 1);
    this.view.group.position.y = -this.view.wall.height * WORLD_SCALE * k * k;
    this.view.group.traverse((child) => {
      if (child instanceof THREE.Mesh) { (child.material as THREE.MeshStandardMaterial).opacity = 1 - k; }
    });
    return k < 1;
  }

  dispose() {
    this.view.dispose();
  }
}

/** A wall blown up, for everyone: a flash, a dust ring rolling out, and chunks of rock flying off it. */
class BlastEffect implements Effect {
  private readonly group = new THREE.Group();
  private readonly flash = glowSprite(0xffd27a, 1);
  private readonly ring = glowMaterial(0xb59b7c);
  private readonly ringMesh: THREE.Mesh;
  private readonly chunks: { mesh: THREE.Mesh; material: THREE.MeshStandardMaterial; velocity: THREE.Vector3; spin: THREE.Vector3 }[] = [];
  private elapsed = 0;

  constructor(parent: THREE.Object3D, wall: Obstacle) {
    const length = wall.halfLength * 2 * WORLD_SCALE;
    const height = wall.height * WORLD_SCALE;
    const reach = (Math.max(wall.halfLength, wall.halfThickness) + EARTH_WALL.blastRadius) * WORLD_SCALE;
    placeGroup(this.group, wall);

    this.flash.position.y = height / 2;
    this.flash.scale.setScalar(length);
    this.ringMesh = onFloor(new THREE.Mesh(new THREE.RingGeometry(reach * 0.85, reach, 64), this.ring), 0.05);
    this.group.add(this.flash, this.ringMesh);

    for (let i = 0; i < CHUNKS; i++) {
      const material = stoneMaterial(STONE_COLORS[i % STONE_COLORS.length]);
      const mesh = new THREE.Mesh(rockGeometry(0.12 + Math.random() * 0.22), material);
      mesh.position.set((Math.random() - 0.5) * length, height * Math.random(), 0);
      // Out from both faces, and up.
      const side = Math.random() < 0.5 ? -1 : 1;
      const velocity = new THREE.Vector3((Math.random() - 0.5) * 3, 2 + Math.random() * 5, side * (2 + Math.random() * 5));
      this.group.add(mesh);
      this.chunks.push({ mesh, material, velocity, spin: new THREE.Vector3(Math.random() * 8, Math.random() * 8, Math.random() * 8) });
    }
    parent.add(this.group);
  }

  update(dt: number) {
    const t = (this.elapsed += dt);
    this.flash.material.opacity = 0.9 * Math.max(0, 1 - t / 0.25);
    const wave = Math.min(t / 0.5, 1);
    this.ringMesh.scale.setScalar(0.4 + 0.6 * wave);
    this.ring.opacity = 0.8 * (1 - wave);

    const fade = Math.max(0, 1 - Math.max(0, t - BLAST_S * 0.6) / (BLAST_S * 0.4));
    for (const chunk of this.chunks) {
      chunk.velocity.y -= GRAVITY * dt;
      chunk.mesh.position.addScaledVector(chunk.velocity, dt);
      if (chunk.mesh.position.y < 0) {
        // Skids to a stop on the floor.
        chunk.mesh.position.y = 0;
        chunk.velocity.multiplyScalar(0.5);
        chunk.velocity.y = 0;
      }
      chunk.mesh.rotation.x += chunk.spin.x * dt;
      chunk.mesh.rotation.y += chunk.spin.y * dt;
      chunk.material.opacity = fade;
    }
    return t < BLAST_S;
  }

  dispose() {
    disposeGroup(this.group);
  }
}

/**
 * While Earth Wall is selected, local only: how far it can be raised around
 * us, and a see-through wall where it would stand (pulled into range, turned
 * across the line from us).
 */
class AimPreview {
  readonly group = new THREE.Group();
  private readonly range = onFloor(new THREE.Mesh(new THREE.RingGeometry(RANGE - 0.08, RANGE, 96), glowMaterial(0xb59b7c, 0.18)));
  private readonly ghost = new THREE.Group();

  constructor(parent: THREE.Object3D) {
    const length = EARTH_WALL.halfLength * 2 * WORLD_SCALE;
    const height = EARTH_WALL.height * WORLD_SCALE;
    const thickness = EARTH_WALL.halfThickness * 2 * WORLD_SCALE;
    const box = new THREE.Mesh(new THREE.BoxGeometry(length, height, thickness), glowMaterial(0xb59b7c, 0.18));
    box.position.y = height / 2;
    const footprint = onFloor(new THREE.Mesh(new THREE.PlaneGeometry(length, thickness), glowMaterial(0xb59b7c, 0.45)), 0.04);
    this.ghost.add(box, footprint);
    this.group.add(this.range, this.ghost);
    this.group.visible = false;
    parent.add(this.group);
  }

  show(origin: GroundPoint, target: GroundPoint | null, yaw: number) {
    this.group.visible = target !== null;
    if (!target) { return; }
    toWorld(origin.x, origin.y, this.range.position).setY(0.03);
    placeGroup(this.ghost, placeEarthWall(origin, target, yaw));
  }

  dispose() {
    disposeGroup(this.group);
  }
}

/** What a click does while Earth Wall is selected: raise a wall, or blow ours up. */
type Armed = "raise" | "detonate";

/**
 * Client side of Earth Wall: select with its slot's key and click to raise a
 * wall where you aim; while it stands, the key and a click again blow it up.
 * Draws every wall standing — from the synced `state.walls`, so each appears
 * and goes with the server's — bursting up, sinking back when its time is
 * up, or blown apart. The server decides everything that matters (cooldown,
 * where it stands, who the blast hurts). `slot` is null when Earth Wall isn't
 * in our kit: then only the walls are drawn.
 */
export class EarthWallController implements SlotSkill {
  private readonly preview: AimPreview;
  private readonly views = new Map<string, WallView>();
  /** Walls blown up: when they leave the state, the blast has them — no sinking. */
  private readonly blasted = new Set<string>();
  /** Our wall, while it stands. */
  private ownWallId: string | undefined;
  /** performance.now() from which our wall can be blown up — counted from arrival, a little behind the server's. */
  private detonateAt = 0;
  private armed: Armed | null = null;
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
    this.preview = new AimPreview(scene.scene);

    const callbacks = Callbacks.get(room);
    callbacks.onAdd("walls", (wall, id) => {
      // Boulders are drawn by their own skill.
      if (wall.kind === "boulder") { return; }
      this.views.get(id)?.dispose();
      this.views.set(id, new WallView(scene.scene, wall));
    });
    callbacks.onRemove("walls", (_wall, id) => {
      const view = this.views.get(id);
      this.views.delete(id);
      if (id === this.ownWallId) {
        this.ownWallId = undefined;
        if (this.armed === "detonate") { this.armed = null; }
      }
      if (!view) { return; }
      if (this.blasted.delete(id)) { view.dispose(); } else { this.effects.add(new SinkEffect(view)); }
    });

    room.onMessage(SERVER_MESSAGE.earthWallRaised, (msg: EarthWallRaised) => {
      clearTimeout(this.confirmTimer);
      // Counting from arrival keeps us a little *behind* the server's own
      // cooldown, so a cast is never sent early and silently refused.
      this.cooldownEndsAt = performance.now() + msg.cooldownMs;
      this.readyAt = this.cooldownEndsAt;
      // Sent at once, so usually ahead of the patch that puts it in the state.
      this.ownWallId = msg.id;
      this.detonateAt = performance.now() + msg.detonateDelayMs;
    });

    room.onMessage(SERVER_MESSAGE.earthWallBlast, (msg: EarthWallBlast) => {
      // Usually ahead of the patch that takes it out of the state.
      const view = this.views.get(msg.id);
      if (view) {
        this.views.delete(msg.id);
        view.dispose();
      } else {
        this.blasted.add(msg.id);
      }
      this.effects.add(new BlastEffect(scene.scene, msg.wall));
    });
  }

  get ready() {
    return performance.now() >= this.readyAt;
  }

  /** Whether clicks raise (or blow up) a wall; otherwise they use the main skill. */
  get selected() {
    return this.armed !== null;
  }

  /** Its key: blow-up mode while our wall stands, otherwise aim a new one — or cancel if already selected. */
  toggle() {
    if (this.armed || !this.slot) {
      this.armed = null;
    } else if (this.ownWallId) {
      this.armed = "detonate";
    } else if (this.ready) {
      this.armed = "raise";
    }
  }

  /** Right-click, another skill's key, death, leaving the room: back to the main skill. */
  cancel() {
    this.armed = null;
  }

  /**
   * Click: raises a wall at the crosshair's ground point (or at max range
   * ahead), or blows ours up — then goes back to the main skill.
   */
  press() {
    if (this.armed === "detonate") {
      // Too soon after raising it: the server wouldn't; stay ready to click again.
      if (performance.now() < this.detonateAt) { return; }
      this.room.send(CLIENT_MESSAGE.earthWallDetonate);
      this.armed = null;
      return;
    }
    if (this.armed !== "raise" || !this.ready) { return; }
    const target = this.scene.groundTarget(EARTH_WALL.range);
    if (!target) { return; }

    this.room.send(CLIENT_MESSAGE.earthWall, target);
    this.armed = null;
    // No double-sends while the server decides; give up waiting after a while.
    this.readyAt = Infinity;
    this.confirmTimer = window.setTimeout(() => { this.readyAt = 0; }, CONFIRM_TIMEOUT_MS);
  }

  release() {}

  /**
   * Per frame, after the camera moves: every wall, the preview and the slot
   * display. `origin` is where we see ourselves (our predicted position) and
   * `yaw` our view's heading.
   */
  update(dt: number, aiming: boolean, origin: GroundPoint, yaw: number) {
    if (!aiming) { this.armed = null; }
    for (const view of this.views.values()) { view.update(dt); }
    this.preview.show(origin, this.armed === "raise" ? this.scene.groundTarget(EARTH_WALL.range) : null, yaw);
    this.showSlot();
  }

  private showSlot() {
    if (!this.slot) { return; }
    this.slot.root.classList.toggle("armed", this.armed !== null);
    const remaining = Math.max(0, this.cooldownEndsAt - performance.now());
    this.slot.root.classList.toggle("cooling", remaining > 0);
    this.slot.root.style.setProperty("--cooldown", String(Math.min(1, remaining / EARTH_WALL.cooldownMs)));
    this.slot.cooldownText.textContent = remaining > 0 ? Math.ceil(remaining / 1000).toString() : "";
  }

  /**
   * A fresh round (`arenaReset`): ready right away. The server took every
   * wall down; they leave the state with it.
   */
  reset() {
    clearTimeout(this.confirmTimer);
    this.readyAt = 0;
    this.cooldownEndsAt = 0;
    this.armed = null;
    this.ownWallId = undefined;
  }

  dispose() {
    this.reset();
    this.preview.dispose();
    this.views.forEach((view) => view.dispose());
    this.views.clear();
    this.blasted.clear();
    this.ownWallId = undefined;
    if (!this.slot) { return; }
    this.slot.root.classList.remove("armed", "cooling");
    this.slot.root.style.setProperty("--cooldown", "0");
    this.slot.cooldownText.textContent = "";
  }
}
