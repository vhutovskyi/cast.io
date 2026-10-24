import * as THREE from "three";
import {
  FREEZING_STREAM, FREEZING_STREAM_TRAVEL_MS, freezingStreamPosition, freezingStreamReach, launchFreezingStream,
  type FreezingStreamCast, type FreezingStreamHit, type FreezingStreamLaunch, type FreezingStreamPoint,
} from "@ligma/backend/skills/freezingStream/freezingStreamConfig";
import { EYE_HEIGHT } from "@ligma/backend/shared/constants";
import { CLIENT_MESSAGE, SERVER_MESSAGE } from "@ligma/backend/shared/messages";
import { type ArenaScene, type Avatar, fromWorld, toWorld, WORLD_SCALE } from "../../render/scene";
import { type Effect, Effects, glowMaterial, glowSprite, onFloor, disposeGroup } from "../../render/effects";
import type { ArenaRoom } from "../../net/arenaRoom";
import type { AbilitySlotUi } from "../../hud/hud";
import type { SlotSkill } from "../slotSkill";

/** The head, in world units: the server's hit sphere. */
const HEAD_RADIUS = FREEZING_STREAM.radius * WORLD_SCALE;
/** World units per second the head is drawn travelling at: the server's speed. */
const HEAD_SPEED = FREEZING_STREAM.speed * WORLD_SCALE;
/** First person: bottom right of the view, where the other elements' hands are too (camera space). */
const VIEW_POSITION = new THREE.Vector3(0.36, -0.28, -0.8);
/** If the server doesn't confirm a cast this fast, treat it as refused. */
const CONFIRM_TIMEOUT_MS = 1500;

/** Points along the jet, and sides round it. */
const POINTS = 36;
const SIDES = 8;
/**
 * The jet's radius at the hand, in world units: others' jets, and your own —
 * thinner, since it leaves from just ahead of your eyes. It swells toward the head.
 */
const THICK_HAND = 0.07;
const THICK_OWN = 0.025;
const THICK_HEAD = HEAD_RADIUS * 0.55;
/** The jet churns: how far it ripples off its line (world units) and how fast the ripples run (radians per second). */
const RIPPLE = 0.05;
const RIPPLE_SPEED = 32;
/** How far behind the head the water has turned to ice, in seconds of travel. */
const FREEZE_LAG_S = 0.08;
/** Once the head stops, the ice catches up over this, holds, then shatters away over the next. */
const SET_S = 0.12;
const HOLD_S = 0.35;
const SHATTER_S = 0.45;
/** Ice crystals growing out of the jet behind the head: one every this many world units, grown over this long. */
const CRYSTAL_SPACING = 0.45;
const CRYSTAL_GROW_S = 0.15;
/** Mist the head leaves behind: how many puffs, how long each lasts, how often one drops. */
const MIST_PUFFS = 16;
const MIST_LIFE_S = 0.35;
const MIST_EVERY_S = 1 / 60;
/** Ice thrown off a body the head struck: how many shards, how long they last, how fast they fly. */
const BURST_SHARDS = 16;
const BURST_S = 0.7;
const BURST_SPEED = 4;
const BURST_GRAVITY = 12;
const BURST_RING = 1.6;

const WATER = new THREE.Color(0x4aa8ff);
const ICE = new THREE.Color(0xd8f4ff);
const WORLD_UP = new THREE.Vector3(0, 1, 0);

/** A point on the server's plane and height, in world space. */
function toWorldPoint(p: FreezingStreamPoint, out: THREE.Vector3) {
  toWorld(p.x, p.y, out);
  out.y = p.z * WORLD_SCALE;
  return out;
}

const clamp01 = (k: number) => Math.min(1, Math.max(0, k));
/** 0..1 eased out: fast at first, settling at the end. */
const easeOut = (k: number) => 1 - (1 - k) ** 3;

/**
 * A tube drawn straight from one point to another, rebuilt every frame: its
 * radius along the way (0 at the start, 1 at the end) from `radius`, and
 * rippling off its line by up to `ripple` toward the far end.
 */
class Tube {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private readonly forward = new THREE.Vector3();
  private readonly side = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly point = new THREE.Vector3();

  constructor(material: THREE.MeshBasicMaterial, private readonly radius: (along: number) => number) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(POINTS * SIDES * 3), 3));
    const index: number[] = [];
    for (let i = 0; i < POINTS - 1; i++) {
      for (let j = 0; j < SIDES; j++) {
        const a = i * SIDES + j;
        const b = i * SIDES + ((j + 1) % SIDES);
        index.push(a, b, a + SIDES, b, b + SIDES, a + SIDES);
      }
    }
    geometry.setIndex(index);
    this.mesh = new THREE.Mesh(geometry, material);
    // Rebuilt every frame: never culled for stale bounds.
    this.mesh.frustumCulled = false;
  }

  /** From `start` to `end`, the ripples at `time` seconds (scaled by `ripple`). */
  build(start: THREE.Vector3, end: THREE.Vector3, time: number, ripple: number) {
    this.forward.subVectors(end, start);
    const length = this.forward.length();
    this.mesh.visible = length > 1e-4;
    if (!this.mesh.visible) { return; }
    this.forward.divideScalar(length);
    this.side.crossVectors(this.forward, WORLD_UP);
    if (this.side.lengthSq() < 1e-6) { this.side.set(1, 0, 0); }
    this.side.normalize();
    this.up.crossVectors(this.side, this.forward).normalize();

    const positions = this.mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < POINTS; i++) {
      const along = i / (POINTS - 1);
      // Ripples run toward the end, growing from nothing at the start.
      const wave = along * along * ripple;
      const phase = along * length * 3 - time * RIPPLE_SPEED;
      this.point.copy(start).addScaledVector(this.forward, along * length)
        .addScaledVector(this.side, Math.sin(phase) * wave)
        .addScaledVector(this.up, Math.cos(phase * 1.3) * wave * 0.7);
      const r = this.radius(along);
      for (let j = 0; j < SIDES; j++) {
        const phi = (j / SIDES) * Math.PI * 2;
        const c = Math.cos(phi) * r;
        const s = Math.sin(phi) * r;
        positions.setXYZ(
          i * SIDES + j,
          this.point.x + this.side.x * c + this.up.x * s,
          this.point.y + this.side.y * c + this.up.y * s,
          this.point.z + this.side.z * c + this.up.z * s,
        );
      }
    }
    positions.needsUpdate = true;
  }
}

/** Mist the head leaves hanging in the air behind it. */
class Mist {
  private readonly group = new THREE.Group();
  private readonly puffs = Array.from({ length: MIST_PUFFS }, () => ({ sprite: glowSprite(0xbfe6ff), age: Infinity }));
  private next = 0;
  private sinceDrop = Infinity;

  constructor(parent: THREE.Object3D) {
    for (const { sprite } of this.puffs) { this.group.add(sprite); }
    parent.add(this.group);
  }

  /** Drops a puff where the head now is, when one is due (`dropping`), and fades the rest. */
  update(dt: number, at: THREE.Vector3, dropping: boolean) {
    this.sinceDrop += dt;
    if (dropping && this.sinceDrop >= MIST_EVERY_S) {
      this.sinceDrop = 0;
      const puff = this.puffs[this.next];
      this.next = (this.next + 1) % MIST_PUFFS;
      puff.age = 0;
      puff.sprite.position.copy(at);
    }
    for (const puff of this.puffs) {
      const k = puff.age / MIST_LIFE_S;
      puff.age += dt;
      puff.sprite.visible = k < 1;
      if (k >= 1) { continue; }
      puff.sprite.scale.setScalar(HEAD_RADIUS * (1 + 2.5 * k));
      puff.sprite.material.opacity = 0.45 * (1 - k) ** 1.5;
    }
  }
}

/** One crystal of ice grown out of the jet. */
interface Crystal { mesh: THREE.Mesh; age: number; size: number; }

/**
 * One stream, for everyone: a jet of water pouring from the caster's hand,
 * its glowing head racing out along the server's line at the server's speed,
 * the water behind it turning to ice and growing crystals as it goes. When
 * the head stops it sets solid, holds a moment and shatters away. Positions
 * are never synced: the head runs out from the launch here, and where it
 * stops comes from the server. `hand` is asked every frame until then, so the
 * jet stays in the hand of a caster who turns or moves.
 */
class StreamEffect implements Effect {
  private readonly group = new THREE.Group();
  private readonly waterMaterial = new THREE.MeshBasicMaterial({ color: WATER, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide });
  private readonly iceMaterial = new THREE.MeshBasicMaterial({ color: ICE, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide });
  private readonly crystalMaterial = new THREE.MeshBasicMaterial({ color: 0xeaf9ff, transparent: true, opacity: 0.85, depthWrite: false });
  private readonly crystalGeometry = new THREE.OctahedronGeometry(1, 0);
  private readonly water: Tube;
  private readonly ice: Tube;
  private readonly crystals: Crystal[] = [];
  private readonly glow = glowSprite(0x6fc8ff, 0.9);
  private readonly core = glowSprite(0xffffff, 0.9);
  private readonly mist: Mist;
  private readonly start = new THREE.Vector3();
  private readonly head = new THREE.Vector3();
  private readonly frost = new THREE.Vector3();
  private readonly offset = new THREE.Vector3();
  /** Where the head stops if the server never says otherwise: a wall, the floor or full reach. */
  private limit: number;
  /** Set once the server says where the head stopped: what to do when ours gets there. */
  private onStop: (() => void) | null = null;
  /** Seconds since the head stopped here; NaN while it still flies. */
  private stoppedFor = NaN;
  private elapsed = 0;
  /** How far along the line the last crystal grew, in world units. */
  private lastCrystal = 0;

  constructor(
    parent: THREE.Object3D,
    private readonly launch: FreezingStreamLaunch,
    private readonly hand: (out: THREE.Vector3) => boolean,
    thick: number,
  ) {
    this.limit = freezingStreamReach(launch).distance;
    this.water = new Tube(this.waterMaterial, (along) => thick + (THICK_HEAD - thick) * along ** 0.6);
    this.ice = new Tube(this.iceMaterial, (along) => (thick + (THICK_HEAD - thick) * along ** 0.6) * 1.35);
    this.glow.scale.setScalar(HEAD_RADIUS * 5);
    this.core.scale.setScalar(HEAD_RADIUS * 1.8);
    this.group.add(this.water.mesh, this.ice.mesh, this.glow, this.core);
    this.mist = new Mist(this.group);
    if (!hand(this.start)) { toWorldPoint(launch, this.start); }
    parent.add(this.group);
  }

  /** The server stopped the head `distance` along its line: once ours gets there, `then` runs. */
  stop(distance: number, then: () => void) {
    this.limit = Math.min(this.limit, distance);
    this.onStop = then;
  }

  update(dt: number) {
    const t = (this.elapsed += dt);
    const flying = Number.isNaN(this.stoppedFor);
    const distance = Math.min(FREEZING_STREAM.speed * t, this.limit);

    if (flying) {
      // Pours from the hand until the head stops; then the ice stays where it is.
      this.hand(this.start);
      const arrived = distance >= this.limit && this.onStop !== null;
      // Safety net if the stop message never comes (e.g. we left the room).
      const lost = t > FREEZING_STREAM_TRAVEL_MS / 1000 + 1;
      if (arrived || lost) {
        this.stoppedFor = 0;
        this.onStop?.();
      }
    } else {
      this.stoppedFor += dt;
    }

    // The head, eased onto the true line from the hand it left over the first stretch.
    toWorldPoint(freezingStreamPosition(this.launch, distance), this.head);
    toWorldPoint(this.launch, this.offset).sub(this.start).multiplyScalar(-1);
    this.head.addScaledVector(this.offset, Math.max(0, 1 - (distance * WORLD_SCALE) / 3));

    // The ice front follows the head; once it stops, it catches up and sets solid.
    const behind = flying ? FREEZE_LAG_S * HEAD_SPEED : FREEZE_LAG_S * HEAD_SPEED * (1 - clamp01(this.stoppedFor / SET_S));
    const length = this.start.distanceTo(this.head);
    const frozen = Math.max(0, length - behind);
    this.frost.copy(this.start).lerp(this.head, length > 0 ? frozen / length : 0);

    const set = flying ? 0 : clamp01(this.stoppedFor / SET_S);
    const shatter = flying ? 0 : clamp01((this.stoppedFor - SET_S - HOLD_S) / SHATTER_S);
    const ripple = RIPPLE * (1 - set);
    this.water.build(this.start, this.head, t, ripple);
    this.ice.build(this.start, this.frost, t, ripple);
    this.waterMaterial.color.lerpColors(WATER, ICE, set * 0.7);
    this.waterMaterial.opacity = 0.8 * (1 - shatter);
    this.iceMaterial.opacity = (0.4 + 0.3 * set) * (1 - shatter);

    // Head: a flickering blaze of cold while it flies, gone once it stops.
    const flicker = 0.85 + 0.15 * Math.sin(t * 47) * Math.sin(t * 31);
    const headLight = flying ? 1 : Math.max(0, 1 - this.stoppedFor / 0.1);
    this.glow.position.copy(this.head);
    this.core.position.copy(this.head);
    this.glow.material.opacity = 0.9 * flicker * headLight;
    this.core.material.opacity = 0.95 * headLight;
    this.glow.scale.setScalar(HEAD_RADIUS * 5 * flicker);
    this.mist.update(dt, this.head, flying);

    this.growCrystals(dt, frozen, shatter);
    return shatter < 1;
  }

  /** Crystals sprout along the ice as it spreads, and fall away as it shatters. */
  private growCrystals(dt: number, frozen: number, shatter: number) {
    for (; this.lastCrystal + CRYSTAL_SPACING <= frozen; this.lastCrystal += CRYSTAL_SPACING) {
      const mesh = new THREE.Mesh(this.crystalGeometry, this.crystalMaterial);
      const along = (this.lastCrystal + CRYSTAL_SPACING) / Math.max(frozen, 1e-6);
      mesh.position.lerpVectors(this.start, this.frost, along)
        .add(this.offset.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(THICK_HEAD * 1.5));
      mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
      mesh.scale.set(0, 0, 0);
      this.group.add(mesh);
      this.crystals.push({ mesh, age: 0, size: THICK_HEAD * (0.5 + 0.7 * Math.random()) });
    }
    for (const crystal of this.crystals) {
      const grown = easeOut(clamp01((crystal.age += dt) / CRYSTAL_GROW_S));
      const size = crystal.size * grown * (1 - 0.6 * shatter);
      // Long and thin, like an icicle.
      crystal.mesh.scale.set(size * 0.5, size * 1.6, size * 0.5);
      if (shatter > 0) { crystal.mesh.position.y -= dt * 3 * shatter; }
    }
    this.crystalMaterial.opacity = 0.85 * (1 - shatter);
  }

  dispose() {
    disposeGroup(this.group);
    this.crystalGeometry.dispose();
  }
}

/**
 * Where the head struck a body: a flash of cold, shards of ice bursting out
 * and falling, and a ring of frost rolling out across the floor beneath.
 * Smaller where it only broke on a wall or the floor.
 */
class IceBurstEffect implements Effect {
  private readonly group = new THREE.Group();
  private readonly flash = glowSprite(0xd8f4ff, 1);
  private readonly cold = glowSprite(0x4aa8ff, 0.8);
  private readonly shardMaterial = new THREE.MeshBasicMaterial({ color: 0xeaf9ff, transparent: true, opacity: 0.9, depthWrite: false });
  private readonly shardGeometry = new THREE.OctahedronGeometry(1, 0);
  private readonly frost = glowMaterial(0x6fc8ff, 0.8);
  private readonly ring: THREE.Mesh;
  private readonly shards: { mesh: THREE.Mesh; velocity: THREE.Vector3; spin: THREE.Vector3 }[] = [];
  private elapsed = 0;

  constructor(parent: THREE.Object3D, at: FreezingStreamPoint, private readonly size: number) {
    toWorldPoint(at, this.group.position);
    this.group.add(this.flash, this.cold);

    const count = Math.round(BURST_SHARDS * size);
    for (let i = 0; i < count; i++) {
      const mesh = new THREE.Mesh(this.shardGeometry, this.shardMaterial);
      const angle = Math.random() * Math.PI * 2;
      const out = BURST_SPEED * size * (0.5 + Math.random());
      const velocity = new THREE.Vector3(Math.cos(angle) * out, BURST_SPEED * size * (0.3 + Math.random()), Math.sin(angle) * out);
      const spin = new THREE.Vector3(Math.random(), Math.random(), Math.random()).multiplyScalar(12);
      const scale = 0.06 + 0.08 * Math.random();
      mesh.scale.set(scale * 0.6, scale * 1.6, scale * 0.6);
      this.group.add(mesh);
      this.shards.push({ mesh, velocity, spin });
    }

    // Frost on the floor, however high the burst.
    this.ring = onFloor(new THREE.Mesh(new THREE.RingGeometry(BURST_RING * 0.8, BURST_RING, 48), this.frost), -this.group.position.y + 0.05);
    this.group.add(this.ring);
    parent.add(this.group);
  }

  update(dt: number) {
    const t = (this.elapsed += dt);
    const k = Math.min(t / BURST_S, 1);
    this.flash.scale.setScalar(this.size * (0.6 + 2.4 * Math.min(t / 0.08, 1)));
    this.flash.material.opacity = Math.max(0, 1 - t / 0.2);
    this.cold.scale.setScalar(this.size * (1.5 + 2 * k));
    this.cold.material.opacity = 0.7 * (1 - k) ** 2;

    for (const { mesh, velocity, spin } of this.shards) {
      velocity.y -= BURST_GRAVITY * dt;
      mesh.position.addScaledVector(velocity, dt);
      // Shards come to rest on the floor.
      mesh.position.y = Math.max(mesh.position.y, -this.group.position.y);
      mesh.rotation.x += spin.x * dt;
      mesh.rotation.y += spin.y * dt;
      mesh.rotation.z += spin.z * dt;
    }
    this.shardMaterial.opacity = 0.9 * (1 - k * k);

    const wave = easeOut(Math.min(t / 0.5, 1));
    this.ring.scale.setScalar(this.size * (0.3 + wave));
    this.frost.opacity = 0.8 * (1 - wave);
    return k < 1;
  }

  dispose() {
    disposeGroup(this.group);
    this.shardGeometry.dispose();
  }
}

/**
 * While Freezing Stream is selected, local only: the line the head will run
 * along from your hand, to where it would stop if no one is in the way, and
 * a glow there.
 */
class AimLine {
  private readonly group = new THREE.Group();
  private readonly material = new THREE.LineBasicMaterial({ color: 0x6fc8ff, transparent: true, opacity: 0.75, depthWrite: false });
  private readonly line: THREE.Line;
  private readonly end = glowSprite(0xd8f4ff, 0.8);
  private readonly point = new THREE.Vector3();

  constructor(parent: THREE.Object3D) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(2 * 3), 3));
    this.line = new THREE.Line(geometry, this.material);
    // Starts at the camera: never let it be culled for leaving its stale bounds.
    this.line.frustumCulled = false;
    this.end.scale.setScalar(HEAD_RADIUS * 3);
    this.group.add(this.line, this.end);
    this.group.visible = false;
    parent.add(this.group);
  }

  /** `hand` is where the jet leaves from, in world space. */
  show(launch: FreezingStreamLaunch | null, hand: THREE.Vector3) {
    this.group.visible = launch !== null;
    if (!launch) { return; }
    toWorldPoint(freezingStreamReach(launch).at, this.point);
    const positions = this.line.geometry.getAttribute("position") as THREE.BufferAttribute;
    positions.setXYZ(0, hand.x, hand.y, hand.z);
    positions.setXYZ(1, this.point.x, this.point.y, this.point.z);
    positions.needsUpdate = true;
    this.end.position.copy(this.point);
    this.end.material.opacity = 0.6 + 0.3 * Math.sin(performance.now() / 120);
  }

  dispose() {
    disposeGroup(this.group);
    this.line.geometry.dispose();
    this.material.dispose();
  }
}

/**
 * Client side of Freezing Stream, water's ultimate: select with its slot's
 * key, fire with a click along the view, the aim line, the stream and the ice
 * burst everyone sees, and the cooldown display. Every stream — your own
 * included — is drawn from the server's `freezingStreamCast`, its head run
 * out here at the server's speed; where it stops, and on whom, is the
 * server's word, which decides everything that matters (cooldown, path, who
 * is struck and frozen). `slot` is null when Freezing Stream isn't in our
 * kit: then only others' streams are drawn.
 */
export class FreezingStreamController implements SlotSkill {
  private readonly aimLine: AimLine;
  /** Streams on their way, by server id. */
  private readonly streams = new Map<number, StreamEffect>();
  /** Remote players' bodies, from the latest `update`: where their jets leave from. */
  private avatars: ReadonlyMap<string, Avatar> = new Map();
  /** performance.now() when the next cast is allowed; Infinity while awaiting confirmation. */
  private readyAt = 0;
  private cooldownEndsAt = 0;
  private confirmTimer = 0;
  private armed = false;
  private readonly hand = new THREE.Vector3();

  constructor(
    private readonly room: ArenaRoom,
    private readonly scene: ArenaScene,
    private readonly effects: Effects,
    private readonly slot: AbilitySlotUi | null,
  ) {
    this.aimLine = new AimLine(scene.scene);

    room.onMessage(SERVER_MESSAGE.freezingStreamCast, (msg: FreezingStreamCast) => {
      if (msg.casterId === room.sessionId) {
        clearTimeout(this.confirmTimer);
        // Counted from arrival: a little behind the server's own cooldown, so
        // a cast is never sent early and silently refused.
        this.cooldownEndsAt = performance.now() + msg.cooldownMs;
        this.readyAt = this.cooldownEndsAt;
      }
      const thick = msg.casterId === room.sessionId ? THICK_OWN : THICK_HAND;
      const stream = new StreamEffect(scene.scene, msg, (out) => this.handPosition(msg.casterId, out), thick);
      this.streams.set(msg.id, this.effects.add(stream));
    });

    // Drawn when our head gets there, a moment behind the server.
    room.onMessage(SERVER_MESSAGE.freezingStreamHit, (msg: FreezingStreamHit) => {
      const burst = () => {
        if (msg.hitId !== undefined) {
          this.effects.add(new IceBurstEffect(scene.scene, msg, 1));
        } else if (msg.distance < FREEZING_STREAM.range) {
          // Broke on a wall or the floor; running out of reach just fades.
          this.effects.add(new IceBurstEffect(scene.scene, msg, 0.4));
        }
      };
      const stream = this.streams.get(msg.id);
      this.streams.delete(msg.id);
      if (stream) { stream.stop(msg.distance, burst); } else { burst(); }
    });
  }

  get ready() {
    return performance.now() >= this.readyAt;
  }

  /** Whether clicks fire Freezing Stream. */
  get selected() {
    return this.armed;
  }

  /** Its key: select to aim, or cancel if already selected. */
  toggle() {
    this.armed = !this.armed && this.ready && this.slot !== null;
  }

  /** Right-click, another skill's key, death, leaving the room. */
  cancel() {
    this.armed = false;
  }

  /** Click: fires along the view if selected, then goes back to the main skill. */
  press() {
    if (!this.armed || !this.ready) { return; }
    this.room.send(CLIENT_MESSAGE.freezingStream, this.aim());
    this.armed = false;
    // No double-sends while the server decides; give up waiting after a while.
    this.readyAt = Infinity;
    this.confirmTimer = window.setTimeout(() => { this.readyAt = 0; }, CONFIRM_TIMEOUT_MS);
  }

  release() {}

  /** The view's direction, as the camera was last placed (radians, as in `MouseLook`). */
  private aim() {
    return { yaw: this.scene.camera.rotation.y, pitch: this.scene.camera.rotation.x };
  }

  /** Where we see ourselves, in simulation units: under the camera, which sits at our predicted eyes. */
  private ownPosition(): FreezingStreamPoint {
    const eye = this.scene.camera.position;
    return { ...fromWorld(eye.x, eye.z), z: eye.y / WORLD_SCALE - EYE_HEIGHT };
  }

  /** Where `casterId`'s jet leaves from, in world space: our view's hand, their avatar's hand, or false to keep the launch point. */
  private handPosition(casterId: string, out: THREE.Vector3) {
    if (casterId === this.room.sessionId) {
      out.copy(VIEW_POSITION);
      this.scene.camera.localToWorld(out);
      return true;
    }
    const avatar = this.avatars.get(casterId);
    if (!avatar?.hand.visible) { return false; }
    avatar.hand.getWorldPosition(out);
    return true;
  }

  /**
   * Per frame, after the camera moves: the aim line while selected, and the
   * slot display. `avatars` are the remote players' bodies, for where their
   * jets leave from.
   */
  update(aiming: boolean, avatars: ReadonlyMap<string, Avatar>) {
    this.avatars = avatars;
    if (!aiming) { this.armed = false; }
    const launch = this.armed ? launchFreezingStream(this.ownPosition(), this.aim()) : null;
    if (launch) { this.handPosition(this.room.sessionId, this.hand); }
    this.aimLine.show(launch, this.hand);
    this.showSlot(Math.max(0, this.cooldownEndsAt - performance.now()));
  }

  private showSlot(remaining: number) {
    if (!this.slot) { return; }
    this.slot.root.classList.toggle("armed", this.armed);
    this.slot.root.classList.toggle("cooling", remaining > 0);
    this.slot.root.style.setProperty("--cooldown", String(remaining / FREEZING_STREAM.cooldownMs));
    this.slot.cooldownText.textContent = remaining > 0 ? Math.ceil(remaining / 1000).toString() : "";
  }

  /**
   * A fresh round (`arenaReset`): ready right away, no streams on their way.
   * The server dropped them; the visuals go with the room's `Effects`.
   */
  reset() {
    clearTimeout(this.confirmTimer);
    this.readyAt = 0;
    this.cooldownEndsAt = 0;
    this.streams.clear();
    this.armed = false;
  }

  dispose() {
    this.reset();
    this.aimLine.dispose();
    this.avatars = new Map();
    this.showSlot(0);
  }
}
