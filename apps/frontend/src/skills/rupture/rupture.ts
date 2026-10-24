import * as THREE from "three";
import {
  RUPTURE, RUPTURE_TRAVEL_MS, ruptureBlocked, ruptureCorners, ruptureHalfWidth, ruptureLocal, ruptureWorld,
  type RuptureAim, type RuptureCast, type RupturePoint,
} from "@ligma/backend/skills/rupture/ruptureConfig";
import { ARENA_WIDTH, ARENA_HEIGHT } from "@ligma/backend/shared/constants";
import type { Obstacle } from "@ligma/backend/shared/obstacles";
import { CLIENT_MESSAGE, SERVER_MESSAGE } from "@ligma/backend/shared/messages";
import { type ArenaScene, toWorld, WORLD_SCALE } from "../../render/scene";
import { type Effect, Effects, glowMaterial, glowSprite, onFloor, disposeGroup } from "../../render/effects";
import type { ArenaRoom } from "../../net/arenaRoom";
import type { AbilitySlotUi } from "../../hud/hud";
import type { SlotSkill } from "../slotSkill";

/** If the server doesn't confirm a cast this fast, treat it as refused. */
const CONFIRM_TIMEOUT_MS = 1500;

/** Rows of spikes across the fan, this many simulation units apart, starting this far out; spikes in a row about this far apart. */
const ROW_GAP = 15;
const FIRST_ROW = 14;
const SPIKE_GAP = 22;
/** How far a spike strays from its place in the grid, in simulation units, so the rows don't show. */
const JITTER = 6;
/** Each spike bursts up as the front reaches it, holds, then crumbles back into the floor (seconds). */
const RISE_S = 0.09;
const HOLD_S = 0.55;
const HOLD_JITTER_S = 0.3;
const CRUMBLE_S = 0.5;
/** Dust kicked up where each spike breaks through: how long it hangs, how high it rises and how wide it spreads (world units). */
const DUST_S = 1.3;
const DUST_RISE = 0.7;
const DUST_SIZE = 1.8;
/** Pebbles thrown up by each spike. */
const PEBBLE_SPEED = 3.5;
const GRAVITY = 14;
/** Cracks running out across the floor from the caster's feet: how many, and how long each bend is (simulation units). */
const CRACKS = 7;
const CRACK_STEP = 10;
const CRACK_WIDTH = 0.09;
/** The scar of torn ground across the fan: how many rows it is drawn with. */
const SCAR_ROWS = 24;
/** Dust rolling along the front while it runs. */
const FRONT_PUFFS = 14;
/** Once the last spike is down, the scar and cracks fade over this (seconds). */
const FADE_S = 0.6;
/** Spikes start crumbling by this long after the front has run its range, plus their own hold; the whole effect ends after. */
const LAST_SPIKE_S = RUPTURE_TRAVEL_MS / 1000 + RISE_S + HOLD_S + HOLD_JITTER_S + CRUMBLE_S;
const END_S = Math.max(LAST_SPIKE_S + FADE_S, RUPTURE_TRAVEL_MS / 1000 + DUST_S);
/** The warning before the front sets off, for everyone (s), and how fast it fades once it does. */
const WINDUP_S = RUPTURE.windupMs / 1000;
const WARNING_FADE_S = 0.2;
/** Dust shaken up at the caster's feet during the wind-up. */
const WINDUP_PUFFS = 6;

/** Earth: rock in three shades, the dark of the cracks, and dust. */
const ROCK_COLORS = [0x7a6249, 0x8f7a63, 0x5e4c3a];
const CRACK_COLOR = 0x21180f;
const SCAR_COLOR = 0x3d2e1f;
const DUST_COLOR = 0xa58c6a;
const AIM_COLOR = 0xb08850;
const AIM_EDGE = 0xe2c79a;

const clamp01 = (k: number) => Math.min(1, Math.max(0, k));
/** 0..1, overshooting a little before settling: rock punching up out of the floor. */
const backOut = (k: number) => 1 + 2.2 * (k - 1) ** 3 + 1.2 * (k - 1) ** 2;
/** 0..1 eased out: fast at first, settling at the end. */
const easeOut = (k: number) => 1 - (1 - k) ** 3;

/** A point in the fan's frame, in the world units of a group placed at its origin and turned to its yaw: forward is -z, right is +x. */
function fanLocal(along: number, across: number, out: THREE.Vector3, height = 0) {
  return out.set(across * WORLD_SCALE, height, -along * WORLD_SCALE);
}

/** Places a group at a fan's origin on the floor, turned to its yaw. */
function placeFan(group: THREE.Object3D, origin: RupturePoint, yaw: number) {
  toWorld(origin.x, origin.y, group.position);
  group.rotation.y = yaw;
}

/** A dust puff: the shared glow, but drawn over what is behind it rather than lighting it up. */
function dustSprite() {
  const sprite = glowSprite(DUST_COLOR);
  sprite.material.blending = THREE.NormalBlending;
  return sprite;
}

/**
 * While Rupture is selected, local only: the fan on the floor ahead along our
 * facing — its outline, a faint fill and a pulse running out across it, the
 * way the front will.
 */
class AimPreview {
  private readonly group = new THREE.Group();
  private readonly fillMaterial = glowMaterial(AIM_COLOR, 0.12);
  private readonly edgeMaterial = new THREE.LineBasicMaterial({ color: AIM_EDGE, transparent: true, opacity: 0.8, depthWrite: false });
  private readonly edge: THREE.LineLoop;
  private readonly pulse = onFloor(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), glowMaterial(AIM_EDGE, 0)), 0.05);

  constructor(parent: THREE.Object3D) {
    // In the fan's own frame: corners measured from an origin at 0, 0 facing yaw 0.
    const corners = ruptureCorners({ x: 0, y: 0 }, 0).map((c) => ruptureLocal({ x: 0, y: 0 }, 0, c));
    // `onFloor` lays the shape's +y along -z: forward.
    const shape = new THREE.Shape(corners.map(({ along, across }) => new THREE.Vector2(across * WORLD_SCALE, along * WORLD_SCALE)));
    const fill = onFloor(new THREE.Mesh(new THREE.ShapeGeometry(shape), this.fillMaterial), 0.03);
    const points = corners.map(({ along, across }) => fanLocal(along, across, new THREE.Vector3(), 0.05));
    this.edge = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points), this.edgeMaterial);
    this.group.add(fill, this.edge, this.pulse);
    this.group.visible = false;
    parent.add(this.group);
  }

  /** `origin` is where we stand; null hides it. */
  show(origin: RupturePoint | null, yaw: number) {
    this.group.visible = origin !== null;
    if (!origin) { return; }
    placeFan(this.group, origin, yaw);
    const k = (performance.now() / 900) % 1;
    const along = RUPTURE.range * k;
    this.pulse.position.z = -along * WORLD_SCALE;
    this.pulse.scale.set(ruptureHalfWidth(along) * 2 * WORLD_SCALE, 0.12, 1);
    (this.pulse.material as THREE.MeshBasicMaterial).opacity = 0.5 * Math.sin(Math.PI * k);
  }

  dispose() {
    disposeGroup(this.group);
    // Not a mesh: `disposeGroup` leaves it.
    this.edge.geometry.dispose();
    this.edgeMaterial.dispose();
  }
}

/** One spike of rock bursting up through the floor: when, how tall, how long it stands. */
interface Spike {
  mesh: THREE.Mesh;
  height: number;
  /** Seconds after the cast the front reaches it. */
  at: number;
  /** Seconds it stands before crumbling. */
  hold: number;
  dust: THREE.Sprite | null;
  pebble: { mesh: THREE.Mesh; velocity: THREE.Vector3; spin: number } | null;
}

/**
 * One rupture, for everyone: first, for the wind-up, the fan glowing on the
 * floor brighter and brighter and dust shaking up at the caster's feet — a
 * warning to get out of it — then the ground tearing open across it from
 * the caster's feet. Its front runs out at the server's speed with dust rolling
 * along it; behind it cracks race across the floor, a scar of torn earth
 * spreads, and jagged spikes and slabs of rock punch up — each as the front
 * reaches it — throwing pebbles and dust, then crumble back into the floor.
 * Nothing breaks through behind a raised wall, as the server's front doesn't
 * reach past one.
 */
class RuptureEffect implements Effect {
  private readonly group = new THREE.Group();
  private readonly rockMaterials = ROCK_COLORS.map((color) => new THREE.MeshStandardMaterial({ color, roughness: 0.95, flatShading: true }));
  /** Unit shapes, built standing on their base: a jagged spike, a slab and a chunk. */
  private readonly rockGeometries = [
    new THREE.ConeGeometry(0.5, 1, 5).translate(0, 0.5, 0),
    new THREE.BoxGeometry(0.9, 1, 0.35).translate(0, 0.5, 0),
    new THREE.DodecahedronGeometry(0.6, 0).scale(1, 1.4, 1).translate(0, 0.35, 0),
  ];
  private readonly pebbleGeometry = new THREE.DodecahedronGeometry(1, 0);
  private readonly spikes: Spike[] = [];
  private readonly crackMaterial = new THREE.MeshBasicMaterial({ color: CRACK_COLOR, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide });
  private readonly cracks: { mesh: THREE.Mesh; steps: number }[] = [];
  private readonly scarMaterial = new THREE.MeshBasicMaterial({ color: SCAR_COLOR, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide });
  private readonly scar: THREE.Mesh;
  private readonly frontPuffs = Array.from({ length: FRONT_PUFFS }, () => dustSprite());
  private readonly point = new THREE.Vector3();
  private readonly warningFill = glowMaterial(AIM_COLOR, 0);
  private readonly warningEdgeMaterial = new THREE.LineBasicMaterial({ color: AIM_EDGE, transparent: true, opacity: 0, depthWrite: false });
  private readonly warningEdge: THREE.LineLoop;
  private readonly windupPuffs = Array.from({ length: WINDUP_PUFFS }, () => dustSprite());
  private elapsed = 0;

  /** `warn`: draw the wind-up's warning — the caster's own cast only, so enemies get no tell. */
  constructor(parent: THREE.Object3D, private readonly cast: RuptureCast, walls: readonly Obstacle[], private readonly warn: boolean) {
    placeFan(this.group, cast, cast.yaw);
    // The warning: the fan the front will run across, in its own frame.
    const corners = ruptureCorners({ x: 0, y: 0 }, 0).map((c) => ruptureLocal({ x: 0, y: 0 }, 0, c));
    const shape = new THREE.Shape(corners.map(({ along, across }) => new THREE.Vector2(across * WORLD_SCALE, along * WORLD_SCALE)));
    this.group.add(onFloor(new THREE.Mesh(new THREE.ShapeGeometry(shape), this.warningFill), 0.03));
    const points = corners.map(({ along, across }) => fanLocal(along, across, new THREE.Vector3(), 0.05));
    this.warningEdge = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points), this.warningEdgeMaterial);
    this.group.add(this.warningEdge, ...this.windupPuffs);
    this.scar = this.buildScar();
    this.buildCracks(walls);
    this.buildSpikes(walls);
    for (const puff of this.frontPuffs) { this.group.add(puff); }
    parent.add(this.group);
  }

  /** Whether the floor at this spot in the fan is open to the front: inside the arena, with no wall in the way. */
  private open(along: number, across: number, walls: readonly Obstacle[]) {
    const at = ruptureWorld(this.cast, this.cast.yaw, along, across);
    const inside = at.x > 4 && at.x < ARENA_WIDTH - 4 && at.y > 4 && at.y < ARENA_HEIGHT - 4;
    return inside && !ruptureBlocked(this.cast, at, walls);
  }

  /** A strip across the fan, row by row, reshaped every frame to end at the front. */
  private buildScar() {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array((SCAR_ROWS + 1) * 2 * 3), 3));
    const index: number[] = [];
    for (let i = 0; i < SCAR_ROWS; i++) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geometry.setIndex(index);
    const mesh = new THREE.Mesh(geometry, this.scarMaterial);
    // Rebuilt every frame: never culled for stale bounds.
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    this.group.add(mesh);
    return mesh;
  }

  /** Cracks fanning out from the caster's feet, each a jagged ribbon on the floor, stopping at a wall. Revealed bend by bend as the front passes. */
  private buildCracks(walls: readonly Obstacle[]) {
    const tan = (ruptureHalfWidth(RUPTURE.range) - RUPTURE.baseHalfWidth) / RUPTURE.range;
    for (let c = 0; c < CRACKS; c++) {
      // Spread across the fan, a little off even.
      const slope = tan * (-0.85 + (1.7 * (c + 0.2 + 0.6 * Math.random())) / CRACKS);
      const reach = RUPTURE.range * (0.7 + 0.3 * Math.random());
      const points: { along: number; across: number }[] = [{ along: 0, across: 0 }];
      for (let along = CRACK_STEP; along <= reach; along += CRACK_STEP) {
        const across = along * slope + (Math.random() - 0.5) * 7;
        if (!this.open(along, across, walls)) { break; }
        points.push({ along, across });
      }
      if (points.length < 2) { continue; }

      // Two triangles per bend, in order, so a draw range reveals it from the caster out.
      const positions = new Float32Array((points.length - 1) * 6 * 3);
      const a = new THREE.Vector3();
      const b = new THREE.Vector3();
      const side = new THREE.Vector3();
      for (let i = 0; i < points.length - 1; i++) {
        fanLocal(points[i].along, points[i].across, a);
        fanLocal(points[i + 1].along, points[i + 1].across, b);
        // Thinning toward its tip.
        const width = CRACK_WIDTH * (1 - (0.7 * i) / points.length);
        side.subVectors(b, a).cross(THREE.Object3D.DEFAULT_UP).normalize().multiplyScalar(width / 2);
        const quad = [
          a.clone().add(side), a.clone().sub(side), b.clone().add(side),
          a.clone().sub(side), b.clone().sub(side), b.clone().add(side),
        ];
        quad.forEach((v, j) => positions.set([v.x, 0.035, v.z], (i * 6 + j) * 3));
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geometry.setDrawRange(0, 0);
      const mesh = new THREE.Mesh(geometry, this.crackMaterial);
      mesh.renderOrder = 2;
      this.group.add(mesh);
      this.cracks.push({ mesh, steps: points.length - 1 });
    }
  }

  /** Rows of rock across the fan — more of them as it widens — each to break through when the front gets there. */
  private buildSpikes(walls: readonly Obstacle[]) {
    for (let row = FIRST_ROW; row <= RUPTURE.range; row += ROW_GAP) {
      const half = ruptureHalfWidth(row);
      const count = Math.max(1, Math.round((half * 2) / SPIKE_GAP));
      for (let i = 0; i < count; i++) {
        const along = Math.min(RUPTURE.range, row + (Math.random() - 0.5) * JITTER);
        const across = -half + ((i + 0.5) * half * 2) / count + (Math.random() - 0.5) * JITTER;
        if (!this.open(along, across, walls)) { continue; }

        const kind = Math.floor(Math.random() * this.rockGeometries.length);
        const mesh = new THREE.Mesh(this.rockGeometries[kind], this.rockMaterials[Math.floor(Math.random() * this.rockMaterials.length)]);
        fanLocal(along, across, mesh.position);
        // Taller further out, where the fan is wide; leaning away from its middle line and a little forward.
        const out = along / RUPTURE.range;
        const height = (0.7 + 0.9 * Math.sin(Math.PI * (0.25 + 0.6 * out))) * (0.75 + 0.5 * Math.random());
        const width = kind === 0 ? 0.45 + 0.35 * Math.random() : 0.35 + 0.25 * Math.random();
        mesh.userData.width = width;
        const lean = (across / Math.max(half, 1)) * 0.45 + (Math.random() - 0.5) * 0.3;
        mesh.rotation.set(-0.15 - 0.2 * Math.random(), Math.random() * Math.PI, -lean);
        mesh.castShadow = true;
        mesh.visible = false;
        this.group.add(mesh);

        let dust: THREE.Sprite | null = null;
        if (i % 2 === 0) {
          dust = dustSprite();
          dust.position.copy(mesh.position);
          dust.visible = false;
          this.group.add(dust);
        }
        let pebble: Spike["pebble"] = null;
        if (Math.random() < 0.6) {
          const p = new THREE.Mesh(this.pebbleGeometry, this.rockMaterials[2]);
          p.scale.setScalar(0.06 + 0.06 * Math.random());
          p.position.copy(mesh.position);
          p.visible = false;
          const angle = Math.random() * Math.PI * 2;
          const velocity = new THREE.Vector3(Math.cos(angle), 1.6 + Math.random(), Math.sin(angle)).multiplyScalar(PEBBLE_SPEED * (0.5 + 0.5 * Math.random()));
          this.group.add(p);
          pebble = { mesh: p, velocity, spin: 6 + 10 * Math.random() };
        }
        this.spikes.push({ mesh, height, at: along / RUPTURE.waveSpeed, hold: HOLD_S + HOLD_JITTER_S * Math.random(), dust, pebble });
      }
    }
  }

  update(dt: number) {
    this.elapsed += dt;
    this.updateWarning(this.elapsed);
    // Everything else runs from the front setting off.
    const t = this.elapsed - WINDUP_S;
    if (t < 0) { return true; }
    const front = Math.min(RUPTURE.waveSpeed * t, RUPTURE.range);
    const fade = clamp01((t - LAST_SPIKE_S) / FADE_S);

    this.updateScar(front, fade);
    for (const { mesh, steps } of this.cracks) {
      mesh.geometry.setDrawRange(0, Math.min(steps, Math.floor(front / CRACK_STEP)) * 6);
    }
    this.crackMaterial.opacity = 0.9 * (1 - fade);

    // Dust rolling along the front while it runs, gone once it is spent.
    const running = RUPTURE.waveSpeed * t < RUPTURE.range + 20;
    const half = ruptureHalfWidth(front);
    this.frontPuffs.forEach((puff, i) => {
      puff.visible = running;
      if (!running) { return; }
      const across = -half + ((i + 0.5) * half * 2) / FRONT_PUFFS + Math.sin(t * 17 + i * 3) * 3;
      fanLocal(front, across, puff.position, 0.3);
      puff.scale.setScalar(0.9 + 0.3 * Math.sin(t * 23 + i));
      puff.material.opacity = 0.55;
    });

    for (const spike of this.spikes) { this.updateSpike(spike, t - spike.at, dt); }
    return t < END_S;
  }

  /** The wind-up's warning: the fan glowing brighter and faster, dust shaking at the feet; gone once the front sets off. */
  private updateWarning(elapsed: number) {
    const k = clamp01(elapsed / WINDUP_S);
    const fade = this.warn ? 1 - clamp01((elapsed - WINDUP_S) / WARNING_FADE_S) : 0;
    const pulse = 0.6 + 0.4 * Math.sin(elapsed * (10 + 20 * k));
    this.warningFill.opacity = 0.3 * k * pulse * fade;
    this.warningEdgeMaterial.opacity = (0.4 + 0.5 * k) * pulse * fade;
    this.windupPuffs.forEach((puff, i) => {
      puff.visible = fade > 0;
      const angle = (i / WINDUP_PUFFS) * Math.PI * 2 + elapsed * 3;
      puff.position.set(Math.cos(angle) * 0.5 * (1 + k), 0.2 + 0.15 * Math.sin(elapsed * 20 + i), Math.sin(angle) * 0.5 * (1 + k));
      puff.scale.setScalar(0.5 + 0.6 * k);
      puff.material.opacity = 0.5 * k * fade;
    });
  }

  /** The torn ground behind the front, from the caster's feet out to it. */
  private updateScar(front: number, fade: number) {
    const positions = this.scar.geometry.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i <= SCAR_ROWS; i++) {
      const along = (front * i) / SCAR_ROWS;
      const half = ruptureHalfWidth(along) * 0.9;
      fanLocal(along, -half, this.point, 0.025);
      positions.setXYZ(i * 2, this.point.x, this.point.y, this.point.z);
      fanLocal(along, half, this.point, 0.025);
      positions.setXYZ(i * 2 + 1, this.point.x, this.point.y, this.point.z);
    }
    positions.needsUpdate = true;
    this.scarMaterial.opacity = 0.55 * (1 - fade);
  }

  /** One spike, `since` seconds after the front reached it (negative: not yet). */
  private updateSpike(spike: Spike, since: number, dt: number) {
    const { mesh, height, hold, dust, pebble } = spike;
    mesh.visible = since >= 0;
    if (since < 0) { return; }

    const rise = backOut(clamp01(since / RISE_S));
    const crumble = clamp01((since - RISE_S - hold) / CRUMBLE_S);
    const width = mesh.userData.width as number;
    // Crumbling: sinks back into the floor, shrinking and shaking as it goes.
    mesh.scale.set(width * (1 - 0.4 * crumble), Math.max(0.01, height * rise), width * (1 - 0.4 * crumble));
    mesh.position.y = -height * crumble * 1.05;
    if (crumble > 0) { mesh.rotation.y += dt * 4 * Math.sin(since * 40); }
    mesh.visible = crumble < 1;

    if (dust) {
      const k = clamp01(since / DUST_S);
      dust.visible = k < 1;
      dust.position.y = 0.25 + DUST_RISE * easeOut(k);
      dust.scale.setScalar(0.4 + DUST_SIZE * easeOut(k));
      dust.material.opacity = 0.6 * (1 - k) ** 1.5;
    }

    if (pebble) {
      const { mesh: p, velocity, spin } = pebble;
      p.visible = since < RISE_S + hold + CRUMBLE_S;
      pebble.velocity.y -= GRAVITY * dt;
      p.position.addScaledVector(velocity, dt);
      if (p.position.y <= 0.05) {
        // Come to rest on the floor.
        p.position.y = 0.05;
        velocity.set(0, 0, 0);
      }
      p.rotation.x += spin * dt;
      p.rotation.z += spin * 0.7 * dt;
    }
  }

  dispose() {
    disposeGroup(this.group);
    // Shared by many meshes: freed once more, harmlessly, here.
    this.rockGeometries.forEach((geometry) => geometry.dispose());
    this.rockMaterials.forEach((material) => material.dispose());
    this.pebbleGeometry.dispose();
    // Not a mesh: `disposeGroup` leaves it.
    this.warningEdge.geometry.dispose();
    this.warningEdgeMaterial.dispose();
  }
}

/**
 * Client side of Rupture, earth's ultimate: select with its slot's key to see
 * the fan ahead on the floor, tear the ground open with a click along our
 * facing, the rupture everyone sees, and the cooldown display. Every rupture —
 * your own included — is drawn from the server's `ruptureCast`, its front run
 * out here at the server's speed; who it strikes and stuns is the server's
 * word (it shows through `StunnedLook`). `slot` is null when Rupture isn't in
 * our kit: then only others' ruptures are drawn.
 */
export class RuptureController implements SlotSkill {
  private readonly preview: AimPreview;
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

    room.onMessage(SERVER_MESSAGE.ruptureCast, (msg: RuptureCast) => {
      if (msg.casterId === room.sessionId) {
        clearTimeout(this.confirmTimer);
        // Counted from arrival: a little behind the server's own cooldown, so
        // a cast is never sent early and silently refused.
        this.cooldownEndsAt = performance.now() + msg.cooldownMs;
        this.readyAt = this.cooldownEndsAt;
      }
      // The walls standing now: the server's front stops at the same ones.
      // Only the caster sees the wind-up: for everyone else the ground just tears open.
      this.effects.add(new RuptureEffect(scene.scene, msg, [...room.state.walls.values()], msg.casterId === room.sessionId));
    });
  }

  get ready() {
    return performance.now() >= this.readyAt;
  }

  /** Whether clicks cast Rupture; otherwise they use the main skill. */
  get selected() {
    return this.armed;
  }

  /** Its key: select Rupture to aim, or cancel if already selected. */
  toggle() {
    this.armed = !this.armed && this.ready && this.slot !== null;
  }

  /** Right-click, another skill's key, death, leaving the room: back to the main skill. */
  cancel() {
    this.armed = false;
  }

  /** Click: tears the ground open along our facing if selected, then goes back to the main skill. */
  press() {
    if (!this.armed || !this.ready) { return; }
    this.room.send(CLIENT_MESSAGE.rupture, { yaw: this.scene.camera.rotation.y } satisfies RuptureAim);
    this.armed = false;
    // No double-sends while the server decides; give up waiting after a while.
    this.readyAt = Infinity;
    this.confirmTimer = window.setTimeout(() => { this.readyAt = 0; }, CONFIRM_TIMEOUT_MS);
  }

  release() {}

  /** Per frame, after the camera moves: the fan while selected, and the slot display. `origin` is where we see ourselves: our predicted position. */
  update(aiming: boolean, origin: RupturePoint) {
    if (!aiming) { this.armed = false; }
    this.preview.show(this.armed ? origin : null, this.scene.camera.rotation.y);
    this.showSlot(Math.max(0, this.cooldownEndsAt - performance.now()));
  }

  private showSlot(remaining: number) {
    if (!this.slot) { return; }
    this.slot.root.classList.toggle("armed", this.armed);
    this.slot.root.classList.toggle("cooling", remaining > 0);
    this.slot.root.style.setProperty("--cooldown", String(remaining / RUPTURE.cooldownMs));
    this.slot.cooldownText.textContent = remaining > 0 ? Math.ceil(remaining / 1000).toString() : "";
  }

  /**
   * A fresh round (`arenaReset`): ready right away. The server dropped every
   * wave on its way; the visuals go with the room's `Effects`.
   */
  reset() {
    clearTimeout(this.confirmTimer);
    this.readyAt = 0;
    this.cooldownEndsAt = 0;
    this.armed = false;
  }

  dispose() {
    this.reset();
    this.preview.dispose();
    this.showSlot(0);
  }
}
