import * as THREE from "three";
import type { Player } from "@ligma/backend/rooms/schema/MyRoomState";
import { BURROW, type BurrowCast, type BurrowSurface } from "@ligma/backend/skills/burrow/burrowConfig";
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

/** The effects this draws, by their server ids. */
const BURROWING_EFFECT = "burrowing";
const BURROWED_EFFECT = "burrowed";
/** If the server doesn't confirm a cast (or answer a burst) this fast, treat it as refused. */
const CONFIRM_TIMEOUT_MS = 1500;

const BODY_RADIUS = PLAYER_HALF * WORLD_SCALE;
const BODY_HEIGHT = PLAYER_HEIGHT * WORLD_SCALE;
/** Who the burst catches, in world units: the server's radius. */
const ERUPT_RADIUS = BURROW.eruptRadius * WORLD_SCALE;

/** A body sinks into the floor over the dig, and pops back out of it over this (s) when it surfaces. */
const DIG_S = BURROW.digMs / 1000;
const RISE_S = 0.18;

/** The heap of earth pushed along over a body under the ground (world units), and how fast it grows or sinks away (s). */
const MOUND_RADIUS = BODY_RADIUS * 1.7;
const MOUND_HEIGHT = 0.5;
const MOUND_FADE_S = 0.25;
/** Clods churning on top of the heap. */
const MOUND_CLODS = 7;
/** The trail behind it: a furrow laid every this far (world units), dust kicked up per world unit moved, how long each lasts (s). */
const FURROW_STEP = 0.45;
const FURROW_S = 1.1;
const TRAIL_DUST_PER_UNIT = 2.5;
const TRAIL_DUST_S = 0.7;

/** Digging in: dirt sprayed out of the hole for the whole dig, the crater left, and how long it lingers after (s). */
const DIG_PEBBLES = 18;
const DIG_DUST = 12;
const DIG_LINGER_S = 0.9;
/** Bursting out: rock thrown up, dust rolling out to the edge of the hit, how long it lasts (s). */
const ERUPT_ROCKS = 16;
const ERUPT_DUST = 24;
const ERUPT_S = 1.2;
/** Coming up quietly: a small puff. */
const QUIET_PEBBLES = 5;
const QUIET_DUST = 6;
const QUIET_S = 0.7;

/** World units/s² pulling thrown rock back down: a little more than a body's, so it reads as heavy. */
const ROCK_GRAVITY = 16;

/** Earth: rock in three shades, the heap, the dark of the hole and the furrow, dust, and the lit edge of the burst ring. */
const ROCK_COLORS = [0x7a6249, 0x8f7a63, 0x5e4c3a];
const MOUND_COLOR = 0x6b5440;
const HOLE_COLOR = 0x21180f;
const FURROW_COLOR = 0x3d2e1f;
const DUST_COLOR = 0xa58c6a;
const RING_COLOR = 0xe2c79a;

const clamp01 = (k: number) => Math.min(1, Math.max(0, k));
/** 0..1 eased out: fast at first, settling at the end. */
const easeOut = (k: number) => 1 - (1 - k) ** 3;

/** Where a player is in their Burrow, from their synced effects: digging in, under the ground, or neither. */
type Phase = "dig" | "under" | null;

function burrowPhase(player: Player, effects: readonly string[] = player.effects): Phase {
  if (player.hp <= 0) { return null; }
  if (effects.includes(BURROWED_EFFECT)) { return "under"; }
  return effects.includes(BURROWING_EFFECT) ? "dig" : null;
}

/** A dust puff: the shared glow, but drawn over what is behind it rather than lighting it up. */
function dustSprite() {
  const sprite = glowSprite(DUST_COLOR);
  sprite.material.blending = THREE.NormalBlending;
  return sprite;
}

/** One flat, round-ish lump of rock: every pebble and clod is this, scaled. */
const rockGeometry = () => new THREE.DodecahedronGeometry(1, 0);
const rockMaterials = () => ROCK_COLORS.map((color) => new THREE.MeshStandardMaterial({ color, roughness: 1, flatShading: true, transparent: true }));

/**
 * Rock thrown out of the floor and falling back onto it, in the local frame
 * of a group standing on the floor (y 0): each piece flies out from near the
 * centre after its own delay, tumbles, and comes to rest where it lands.
 */
class Rocks {
  private readonly geometry = rockGeometry();
  private readonly materials = rockMaterials();
  private readonly pieces: { mesh: THREE.Mesh; velocity: THREE.Vector3; spin: THREE.Vector3; delay: number; landed: boolean }[] = [];

  /** `speed`: how fast they fly out along the floor; `up`: how fast up; `size`: how big; `over`: the delays spread over this (s). */
  constructor(parent: THREE.Object3D, count: number, { speed, up, size, over }: { speed: number; up: number; size: number; over: number }) {
    for (let i = 0; i < count; i++) {
      const mesh = new THREE.Mesh(this.geometry, this.materials[i % this.materials.length]);
      const angle = Math.random() * Math.PI * 2;
      const out = speed * (0.5 + Math.random() * 0.7);
      mesh.scale.setScalar(size * (0.5 + Math.random() * 0.8));
      mesh.position.set(Math.cos(angle) * BODY_RADIUS * 0.5, 0, Math.sin(angle) * BODY_RADIUS * 0.5);
      mesh.visible = false;
      parent.add(mesh);
      this.pieces.push({
        mesh,
        velocity: new THREE.Vector3(Math.cos(angle) * out, up * (0.6 + Math.random() * 0.6), Math.sin(angle) * out),
        spin: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(14),
        delay: Math.random() * over,
        landed: false,
      });
    }
  }

  /** `t`: seconds since they started flying; `opacity`: how much is left of them. */
  update(dt: number, t: number, opacity: number) {
    for (const piece of this.pieces) {
      if (t < piece.delay) { continue; }
      piece.mesh.visible = true;
      if (piece.landed) { continue; }
      piece.velocity.y -= ROCK_GRAVITY * dt;
      piece.mesh.position.addScaledVector(piece.velocity, dt);
      piece.mesh.rotation.x += piece.spin.x * dt;
      piece.mesh.rotation.y += piece.spin.y * dt;
      piece.mesh.rotation.z += piece.spin.z * dt;
      if (piece.mesh.position.y <= 0 && piece.velocity.y < 0) {
        piece.mesh.position.y = 0;
        piece.landed = true;
      }
    }
    for (const material of this.materials) { material.opacity = opacity; }
  }

  /** The geometry and materials are shared by every piece, so freed once each here (`disposeGroup` frees them per mesh too; again is harmless). */
  dispose() {
    this.geometry.dispose();
    this.materials.forEach((material) => material.dispose());
  }
}

/** Dust thrown out low along the floor and billowing up, in the local frame of a group standing on the floor. */
class DustBurst {
  private readonly puffs: { sprite: THREE.Sprite; dir: THREE.Vector3; reach: number; rise: number; delay: number }[] = [];

  /** `reach`: how far out along the floor it rolls; `rise`: how high it billows; `over`: the puffs set off over this (s). */
  constructor(parent: THREE.Object3D, count: number, { reach, rise, over }: { reach: number; rise: number; over: number }) {
    for (let i = 0; i < count; i++) {
      const sprite = dustSprite();
      const angle = (i / count) * Math.PI * 2 + Math.random() * 0.4;
      parent.add(sprite);
      this.puffs.push({
        sprite,
        dir: new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle)),
        reach: reach * (0.6 + Math.random() * 0.5),
        rise: rise * (0.5 + Math.random() * 0.8),
        delay: Math.random() * over,
      });
    }
  }

  /** `t`: seconds since it started; each puff lives `life` (s) from its own delay. */
  update(t: number, life: number, opacity: number) {
    for (const puff of this.puffs) {
      const k = clamp01((t - puff.delay) / life);
      const out = easeOut(k);
      puff.sprite.visible = k > 0 && k < 1;
      puff.sprite.position.copy(puff.dir).multiplyScalar(BODY_RADIUS + puff.reach * out).setY(0.15 + puff.rise * out);
      puff.sprite.scale.setScalar(0.5 + 1.4 * k);
      puff.sprite.material.opacity = opacity * (1 - k);
    }
  }
}

/**
 * Where a mage digs in, for everyone (we see it round our own feet): a dark
 * hole opening in the floor, a rim of torn earth round it, dirt and pebbles
 * sprayed out for the whole dig, then it all settles and fades.
 */
class DigEffect implements Effect {
  private readonly group = new THREE.Group();
  private readonly holeMaterial = new THREE.MeshBasicMaterial({ color: HOLE_COLOR, transparent: true, opacity: 0, depthWrite: false });
  private readonly rimMaterial = new THREE.MeshBasicMaterial({ color: ROCK_COLORS[0], transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
  private readonly hole = onFloor(new THREE.Mesh(new THREE.CircleGeometry(1, 28), this.holeMaterial), 0.03);
  private readonly rim = onFloor(new THREE.Mesh(new THREE.RingGeometry(0.75, 1, 28), this.rimMaterial), 0.04);
  private readonly rocks: Rocks;
  private readonly dust: DustBurst;
  private elapsed = 0;

  /** `at`: the caster's feet, in world units. */
  constructor(parent: THREE.Object3D, at: THREE.Vector3) {
    this.group.position.copy(at);
    this.group.add(this.hole, this.rim);
    this.rocks = new Rocks(this.group, DIG_PEBBLES, { speed: 2.2, up: 4.5, size: 0.07, over: DIG_S });
    this.dust = new DustBurst(this.group, DIG_DUST, { reach: 0.9, rise: 0.8, over: DIG_S });
    parent.add(this.group);
  }

  update(dt: number) {
    const t = (this.elapsed += dt);
    // The hole opens as they sink into it, then closes over once they are under.
    const open = easeOut(clamp01(t / DIG_S));
    const fade = 1 - clamp01((t - DIG_S) / DIG_LINGER_S);
    this.hole.scale.setScalar(BODY_RADIUS * (0.6 + 0.9 * open));
    this.holeMaterial.opacity = 0.85 * open * fade;
    this.rim.scale.setScalar(BODY_RADIUS * (0.8 + 1.4 * open));
    this.rimMaterial.opacity = 0.7 * open * fade;
    this.rocks.update(dt, t, fade);
    this.dust.update(t, 0.8, 0.55);
    return t < DIG_S + DIG_LINGER_S;
  }

  dispose() {
    disposeGroup(this.group);
    this.rocks.dispose();
  }
}

/**
 * Where a mage comes out of the ground, for everyone. Bursting out: a ring
 * racing over the floor to the edge of the hit, a torn patch, rock thrown up
 * high and dust rolling out. Coming up quietly: a small puff and a few pebbles.
 */
class SurfaceEffect implements Effect {
  private readonly group = new THREE.Group();
  private readonly ringMaterial = glowMaterial(RING_COLOR, 0);
  private readonly ring = onFloor(new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 64), this.ringMaterial), 0.06);
  private readonly patchMaterial = new THREE.MeshBasicMaterial({ color: FURROW_COLOR, transparent: true, opacity: 0, depthWrite: false });
  private readonly patch = onFloor(new THREE.Mesh(new THREE.CircleGeometry(1, 32), this.patchMaterial), 0.03);
  private readonly rocks: Rocks;
  private readonly dust: DustBurst;
  private readonly duration: number;
  /** How far the ring runs out (world units). */
  private readonly reach: number;
  private elapsed = 0;

  /** `at`: the caster's feet, in world units. */
  constructor(parent: THREE.Object3D, at: THREE.Vector3, private readonly erupted: boolean) {
    this.group.position.copy(at);
    this.group.add(this.ring, this.patch);
    this.duration = erupted ? ERUPT_S : QUIET_S;
    this.reach = erupted ? ERUPT_RADIUS : MOUND_RADIUS * 1.3;
    this.rocks = erupted
      ? new Rocks(this.group, ERUPT_ROCKS, { speed: 3.5, up: 8, size: 0.14, over: 0.05 })
      : new Rocks(this.group, QUIET_PEBBLES, { speed: 1.2, up: 2.5, size: 0.06, over: 0.1 });
    this.dust = erupted
      ? new DustBurst(this.group, ERUPT_DUST, { reach: ERUPT_RADIUS * 0.85, rise: 1.4, over: 0.08 })
      : new DustBurst(this.group, QUIET_DUST, { reach: 0.6, rise: 0.5, over: 0.1 });
    parent.add(this.group);
  }

  update(dt: number) {
    const t = (this.elapsed += dt);
    const k = clamp01(t / this.duration);

    // The ring: out to the edge of the hit fast, easing off, then gone.
    const wave = clamp01(t / (this.erupted ? 0.3 : 0.35));
    this.ring.scale.setScalar(Math.max(0.01, this.reach * easeOut(wave)));
    this.ringMaterial.opacity = (this.erupted ? 0.9 : 0.35) * (1 - wave * wave);
    this.patch.scale.setScalar(this.erupted ? BODY_RADIUS * 3 : BODY_RADIUS * 1.6);
    this.patchMaterial.opacity = 0.6 * clamp01(t / 0.05) * (1 - k);

    this.rocks.update(dt, t, 1 - clamp01((t - this.duration * 0.6) / (this.duration * 0.4)));
    this.dust.update(t, this.duration * 0.9, this.erupted ? 0.6 : 0.45);
    return k < 1;
  }

  dispose() {
    disposeGroup(this.group);
    this.rocks.dispose();
  }
}

/** A lumpy dome: a half sphere whose surface is pushed in and out by position, so seams agree and it stays closed. */
function moundGeometry() {
  const geometry = new THREE.SphereGeometry(1, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2);
  const position = geometry.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    v.fromBufferAttribute(position, i);
    const lump = 1 + 0.16 * Math.sin(v.x * 7.1 + v.z * 3.3) * Math.cos(v.z * 5.7 - v.x * 2.1 + v.y * 4);
    position.setXYZ(i, v.x * lump, v.y * lump, v.z * lump);
  }
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * The heap of churned earth over someone under the ground — a remote body,
 * or ourselves (seen looking down) — pushed along wherever they go: a lumpy
 * dome, clods tumbling over its top, and behind it a dark furrow and dust
 * that fade. `update` gets their feet (world units) and how big the heap
 * should be (0..1); it grows and sinks away rather than popping — sinking
 * away where it is, so it doesn't fly up with a body bursting out.
 */
class Mound {
  private readonly heap = new THREE.Group();
  private readonly heapMaterial = new THREE.MeshStandardMaterial({ color: MOUND_COLOR, roughness: 1, flatShading: true, transparent: true });
  private readonly dome = new THREE.Mesh(moundGeometry(), this.heapMaterial);
  private readonly clodGeometry = rockGeometry();
  private readonly clodMaterials = rockMaterials();
  private readonly clods = Array.from({ length: MOUND_CLODS }, (_, i) => {
    const mesh = new THREE.Mesh(this.clodGeometry, this.clodMaterials[i % this.clodMaterials.length]);
    mesh.scale.setScalar(0.06 + Math.random() * 0.06);
    this.heap.add(mesh);
    return { mesh, angle: (i / MOUND_CLODS) * Math.PI * 2, out: 0.3 + Math.random() * 0.55, phase: Math.random() * Math.PI * 2 };
  });
  /** The furrow and dust left behind: in the world, not on the heap, so they stay where they were laid. */
  private readonly trail = new THREE.Group();
  private readonly furrowGeometry = new THREE.PlaneGeometry(1, 1);
  private readonly furrows: { mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>; age: number }[] = [];
  private readonly dust: { sprite: THREE.Sprite; age: number; drift: THREE.Vector3 }[] = [];
  /** Where the furrow was last laid to, and where the heap was last frame. */
  private furrowFrom: THREE.Vector3 | null = null;
  private last: THREE.Vector3 | null = null;
  private owedDust = 0;
  private size = 0;
  private time = 0;

  constructor(parent: THREE.Object3D) {
    this.heap.add(this.dome);
    this.heap.visible = false;
    parent.add(this.heap, this.trail);
  }

  /** False once the heap has sunk away and the trail behind it has faded. */
  update(dt: number, at: THREE.Vector3 | null, target: number) {
    const t = (this.time += dt);
    this.size = at ? (this.size < target ? Math.min(target, this.size + dt / MOUND_FADE_S) : Math.max(target, this.size - dt / MOUND_FADE_S)) : 0;
    this.heap.visible = at !== null && this.size > 0;

    if (at && this.heap.visible) {
      // Following them only while they are (or are going) under it: sinking away, it stays put.
      const following = target > 0;
      const moved = following && this.last ? Math.hypot(at.x - this.last.x, at.z - this.last.z) : 0;
      const speed = dt > 0 ? moved / dt : 0;
      // Faces where it goes, a little longer along it the faster it goes, heaving as it pushes earth aside.
      if (moved > 1e-4) { this.heap.rotation.y = Math.atan2(at.x - this.last!.x, at.z - this.last!.z); }
      const stretch = 1 + Math.min(speed / 20, 0.35);
      const heave = 1 + 0.12 * Math.sin(t * 17) * Math.min(speed / 5, 1);
      if (following) { this.heap.position.copy(at); }
      this.dome.scale.set(MOUND_RADIUS * this.size, MOUND_HEIGHT * this.size * heave, MOUND_RADIUS * this.size * stretch);
      this.heapMaterial.opacity = Math.min(1, this.size * 2);
      for (const clod of this.clods) {
        // Rolling over the top from the front to the back, as if dug out ahead and thrown behind.
        const roll = (clod.phase + t * 2.2) % (Math.PI * 2);
        const r = clod.out * MOUND_RADIUS * this.size;
        clod.mesh.position.set(Math.cos(clod.angle) * r, 0, Math.sin(clod.angle) * r * stretch + Math.cos(roll) * 0.08);
        clod.mesh.position.y = MOUND_HEIGHT * this.size * Math.sqrt(Math.max(0, 1 - clod.out * clod.out)) + Math.max(0, Math.sin(roll)) * 0.12;
        clod.mesh.rotation.set(roll, clod.angle, roll * 0.5);
      }
      this.clodMaterials.forEach((material) => { material.opacity = this.heapMaterial.opacity; });

      if (following && this.size > 0.5) {
        this.layFurrow(at);
        this.kickDust(at, moved);
      } else {
        this.furrowFrom = null;
      }
    }
    this.last = at && (this.last ?? new THREE.Vector3()).copy(at);
    if (!at) { this.furrowFrom = null; }

    this.fadeTrail(dt);
    return this.heap.visible || this.furrows.length > 0 || this.dust.length > 0;
  }

  /** A strip of torn earth from where the last one ended to here, once it is long enough. */
  private layFurrow(at: THREE.Vector3) {
    if (!this.furrowFrom) {
      this.furrowFrom = at.clone();
      return;
    }
    const dx = at.x - this.furrowFrom.x;
    const dz = at.z - this.furrowFrom.z;
    const length = Math.hypot(dx, dz);
    if (length < FURROW_STEP) { return; }
    const material = new THREE.MeshBasicMaterial({ color: FURROW_COLOR, transparent: true, opacity: 0.55, depthWrite: false });
    const mesh = new THREE.Mesh(this.furrowGeometry, material);
    // Flat on the floor (XY plane laid along -z), then turned in that plane along the path.
    mesh.rotation.set(-Math.PI / 2, 0, Math.atan2(-dz, dx));
    mesh.position.set((at.x + this.furrowFrom.x) / 2, (at.y + this.furrowFrom.y) / 2 + 0.025, (at.z + this.furrowFrom.z) / 2);
    mesh.scale.set(length + 0.1, MOUND_RADIUS * (0.7 + Math.random() * 0.25), 1);
    this.trail.add(mesh);
    this.furrows.push({ mesh, age: 0 });
    this.furrowFrom.copy(at);
  }

  /** Dust thrown up behind the heap, more the further it went this frame. */
  private kickDust(at: THREE.Vector3, moved: number) {
    for (this.owedDust += moved * TRAIL_DUST_PER_UNIT; this.owedDust >= 1; this.owedDust--) {
      const sprite = dustSprite();
      const angle = Math.random() * Math.PI * 2;
      sprite.position.set(at.x + Math.cos(angle) * MOUND_RADIUS * 0.8, at.y + 0.15, at.z + Math.sin(angle) * MOUND_RADIUS * 0.8);
      this.trail.add(sprite);
      this.dust.push({ sprite, age: 0, drift: new THREE.Vector3(Math.cos(angle) * 0.4, 0.5 + Math.random() * 0.4, Math.sin(angle) * 0.4) });
    }
  }

  private fadeTrail(dt: number) {
    for (let i = this.furrows.length - 1; i >= 0; i--) {
      const furrow = this.furrows[i];
      const k = (furrow.age += dt) / FURROW_S;
      if (k < 1) {
        furrow.mesh.material.opacity = 0.55 * (1 - k * k);
        continue;
      }
      furrow.mesh.removeFromParent();
      furrow.mesh.material.dispose();
      this.furrows.splice(i, 1);
    }
    for (let i = this.dust.length - 1; i >= 0; i--) {
      const puff = this.dust[i];
      const k = (puff.age += dt) / TRAIL_DUST_S;
      if (k < 1) {
        puff.sprite.position.addScaledVector(puff.drift, dt);
        puff.sprite.scale.setScalar(0.35 + 0.8 * k);
        puff.sprite.material.opacity = 0.5 * (1 - k);
        continue;
      }
      puff.sprite.removeFromParent();
      puff.sprite.material.dispose();
      this.dust.splice(i, 1);
    }
  }

  dispose() {
    disposeGroup(this.heap);
    disposeGroup(this.trail);
    // Shared: freed once more here, in case nothing was using them when the groups went.
    this.furrowGeometry.dispose();
    this.clodGeometry.dispose();
    this.clodMaterials.forEach((material) => material.dispose());
  }
}

/** Someone digging in, under the ground, or just come up: their heap, and how far their body is sunk. */
interface Burrower {
  mound: Mound;
  /** Their body, if remote: we have none (first person). */
  avatar?: Avatar;
  /** 0 standing on the floor .. 1 all the way under it. */
  sink: number;
}

/** Shows a body again, standing where the arena puts it next frame. */
function restore(avatar: Avatar | undefined) {
  if (avatar) { avatar.group.visible = true; }
}

/**
 * Client side of Burrow: its slot's key digs in at once — no aiming — and,
 * once we are under, a click (or the key again) bursts us out. Also draws
 * everyone's: the hole and dirt sprayed as they dig in, their body sinking
 * into the floor and hidden (name tag and health bar too, which would give
 * them away), the heap of earth pushed along over them with its furrow and
 * dust, and the burst — or the quiet puff — as they come up. Our own view
 * never moves: the camera stays where the movement step puts it, and only
 * the world round our feet shows the digging and the heap we push along.
 * Who is digging or under is read from the synced effects, so it holds for
 * anyone who joins mid-burrow — ours with what our own presses have put on
 * ahead of the room (`actions`): digging in, travelling under the ground and
 * bursting out ride our inputs and are predicted from the very step we press
 * them. The server decides everything that matters (cooldown, the phases,
 * the speed, who gets hit). `slot` is null when Burrow isn't in our kit: then
 * only others' are drawn.
 */
export class BurrowController implements SlotSkill, ArenaSkillController {
  private readonly burrowers = new Map<string, Burrower>();
  private readonly feet = new THREE.Vector3();
  private alive = true;
  /** We are under the ground, as our predicted effects say: a click bursts us out. */
  private under = false;
  /** Pressed bursting out: no more until we are out (or it came to nothing). */
  private eruptSent = false;
  private eruptTimer = 0;
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
    room.onMessage(SERVER_MESSAGE.burrowCast, (msg: BurrowCast) => {
      this.effects.add(new DigEffect(scene.scene, toWorld(msg.x, msg.y).setY(msg.z * WORLD_SCALE)));
      if (msg.casterId !== room.sessionId) { return; }
      // Already digging in and cooling down since the key: the room took it.
      clearTimeout(this.confirmTimer);
    });

    // Where they really came up: the body appears there as the effect goes, in the next patch.
    room.onMessage(SERVER_MESSAGE.burrowSurface, (msg: BurrowSurface) => {
      this.effects.add(new SurfaceEffect(scene.scene, toWorld(msg.x, msg.y).setY(msg.z * WORLD_SCALE), msg.erupted));
    });
  }

  get ready() {
    return performance.now() >= this.readyAt;
  }

  /** Never selected: it has nothing to aim, and bursting out takes clicks through `eruptByClick`. */
  get selected() {
    return false;
  }

  /** Its key: dig in right away, if it's ready; under the ground, burst out. */
  toggle() {
    if (this.under) {
      this.erupt();
      return;
    }
    if (!this.slot || !this.ready || !this.alive) { return; }
    // With our next input: rooted from that very step, predicted, as the room digs us in on the same one.
    this.actions.press(INPUT_ACTION.burrow);
    this.cooldownEndsAt = performance.now() + BURROW.cooldownMs;
    this.readyAt = this.cooldownEndsAt;
    // Not taken after a while (refused, or lost): ready again, and the prediction was put right.
    this.confirmTimer = window.setTimeout(() => {
      this.readyAt = 0;
      this.cooldownEndsAt = 0;
    }, CONFIRM_TIMEOUT_MS);
  }

  /** Nothing to stop: once in, we stay under until we burst out or the time runs out. */
  cancel() {}

  press() {}

  release() {}

  /**
   * A left click while we are under the ground: bursts out instead of using
   * any other skill. False if we aren't under, so the click goes on as usual.
   */
  eruptByClick(): boolean {
    if (!this.under) { return false; }
    this.erupt();
    return true;
  }

  /** Once, with our next input: out of the ground from that very step, predicted. */
  private erupt() {
    if (this.eruptSent) { return; }
    this.actions.press(INPUT_ACTION.burrowErupt);
    this.eruptSent = true;
    this.eruptTimer = window.setTimeout(() => { this.eruptSent = false; }, CONFIRM_TIMEOUT_MS);
  }

  /**
   * Per frame, after remote bodies are placed: sinks and hides whoever is
   * digging in or under, moves their heaps (ours at our predicted feet), and
   * the slot display.
   */
  update(frame: ArenaFrame) {
    this.alive = frame.alive;
    const own = frame.players.get(this.room.sessionId);
    // Ours as predicted: under from the step the dig ends, out from the step we burst.
    const ownEffects = own ? this.actions.effectsNow(own.effects) : [];
    this.under = frame.alive && own !== undefined && burrowPhase(own, ownEffects) === "under";
    if (!this.under && this.eruptSent) {
      clearTimeout(this.eruptTimer);
      this.eruptSent = false;
    }

    for (const [sessionId, player] of frame.players) {
      const ours = sessionId === this.room.sessionId;
      const avatar = ours ? undefined : frame.avatars.get(sessionId);
      if (!ours && !avatar) { continue; }
      const phase = ours ? burrowPhase(player, ownEffects) : burrowPhase(player);
      let burrower = this.burrowers.get(sessionId);
      if (!burrower) {
        if (!phase) { continue; }
        burrower = { mound: new Mound(this.scene.scene), avatar, sink: 0 };
        this.burrowers.set(sessionId, burrower);
      }

      // Into the floor over the dig, all the way while under, back out quickly
      // after (bursting out, the jump carries the body up too); dead, at once.
      if (player.hp <= 0) { burrower.sink = 0; }
      else if (phase === "dig") { burrower.sink = Math.min(1, burrower.sink + frame.dt / DIG_S); }
      else if (phase === "under") { burrower.sink = 1; }
      else { burrower.sink = Math.max(0, burrower.sink - frame.dt / RISE_S); }

      const feet = ours
        ? toWorld(frame.self.x, frame.self.y, this.feet).setY(frame.self.z * WORLD_SCALE)
        : this.feet.copy(avatar!.group.position);
      // The heap piles up as they sink into it, and sinks away as they come out.
      const size = phase === "under" ? 1 : phase === "dig" ? 0.6 * burrower.sink : 0;
      const drawn = burrower.mound.update(frame.dt, feet, size);

      if (avatar) {
        // The arena placed the body this frame: lower it from there. Hidden
        // under the ground, name tag and health bar with it.
        avatar.group.position.y -= burrower.sink * BODY_HEIGHT;
        avatar.group.visible = phase !== "under";
      }
      if (!phase && burrower.sink === 0 && !drawn) { this.drop(sessionId); }
    }

    // Whoever left without a goodbye (or whose body went): their heap goes too.
    for (const sessionId of this.burrowers.keys()) {
      if (!frame.players.has(sessionId) || (sessionId !== this.room.sessionId && !frame.avatars.has(sessionId))) { this.drop(sessionId); }
    }

    this.showSlot();
  }

  /** Stops drawing someone's burrow: their body back on show, their heap gone. */
  private drop(sessionId: string) {
    const burrower = this.burrowers.get(sessionId);
    if (!burrower) { return; }
    restore(burrower.avatar);
    burrower.mound.dispose();
    this.burrowers.delete(sessionId);
  }

  private showSlot() {
    if (!this.slot) { return; }
    // Lit while a click would burst us out.
    this.slot.root.classList.toggle("armed", this.under);
    const remaining = Math.max(0, this.cooldownEndsAt - performance.now());
    this.slot.root.classList.toggle("cooling", remaining > 0);
    this.slot.root.style.setProperty("--cooldown", String(Math.min(1, remaining / BURROW.cooldownMs)));
    this.slot.cooldownText.textContent = remaining > 0 ? (remaining / 1000).toFixed(1) : "";
  }

  /** A remote player left: their body goes with them, and their heap with it. */
  removePlayer(sessionId: string) {
    this.drop(sessionId);
  }

  /**
   * A fresh round (`arenaReset`): ready right away, nobody under, every body
   * back on show. The server dropped it all; the digs and bursts go with the
   * room's `Effects`.
   */
  reset() {
    clearTimeout(this.confirmTimer);
    clearTimeout(this.eruptTimer);
    this.readyAt = 0;
    this.cooldownEndsAt = 0;
    this.under = false;
    this.eruptSent = false;
    [...this.burrowers.keys()].forEach((sessionId) => this.drop(sessionId));
  }

  dispose() {
    this.reset();
    this.showSlot();
  }
}
