import * as THREE from "three";
import {
  WHIP_SHARD, whipShardPosition, whipShardVelocity,
  type WhipShardCast, type WhipShardHit, type WhipShardLaunch, type WhipShardPoint,
} from "@ligma/backend/skills/waterWhip/whipShardConfig";
import { ARENA_HEIGHT, ARENA_WIDTH } from "@ligma/backend/shared/constants";
import { SERVER_MESSAGE } from "@ligma/backend/shared/messages";
import { type ArenaScene, toWorld, WORLD_SCALE } from "../../render/scene";
import { type Effect, Effects, glowMaterial, glowSprite, onFloor, disposeGroup } from "../../render/effects";
import type { ArenaRoom } from "../../net/arenaRoom";

/** The server's hit radius, in world units. */
const RADIUS = WHIP_SHARD.radius * WORLD_SCALE;
/** The flying shard, in world units: point to back, and across its widest. */
const SHARD_LENGTH = 0.8;
const SHARD_WIDTH = 0.11;
/** First person: where your own shard is drawn leaving from — just below the middle of the view (camera space). */
const VIEW_LAUNCH = new THREE.Vector3(0, -0.12, -0.6);
/** Your own shard leaves where you see it and settles onto its true path over this long. */
const BLEND_S = 0.08;
/** Frost left behind a shard in flight: how many motes, how long each lasts, how often one drops. */
const TRAIL_MOTES = 14;
const TRAIL_LIFE_S = 0.25;
const TRAIL_EVERY_S = 1 / 60;
/** Splinters thrown off where it shatters: how many, how long they last, how fast they fly. */
const SPLINTERS = 14;
const SHATTER_S = 0.6;
const SPLINTER_SPEED = 4;
const SPLINTER_GRAVITY = 12;

const FROST_BRIGHT = new THREE.Color(0xd8f4ff);
const FROST_DEEP = new THREE.Color(0x4aa8ff);
const UP = new THREE.Vector3(0, 1, 0);

/** Pale, faceted, a little see-through, with a cold glow of its own — lit by the scene. */
function iceMaterial() {
  return new THREE.MeshStandardMaterial({
    color: 0xd8f4ff,
    emissive: 0x2a7bff,
    emissiveIntensity: 0.35,
    roughness: 0.15,
    metalness: 0.1,
    flatShading: true,
    transparent: true,
    opacity: 0.9,
  });
}

/** A point on the server's plane and height, in world space. */
function toWorldPoint(p: WhipShardPoint, out: THREE.Vector3) {
  toWorld(p.x, p.y, out);
  out.y = p.z * WORLD_SCALE;
  return out;
}

/** A direction on the server's plane and height, in world space (unit length). */
function toWorldDirection(v: WhipShardPoint, out: THREE.Vector3) {
  out.set(v.x, v.z, v.y);
  if (out.lengthSq() < 1e-9) { return out.set(0, 0, -1); }
  return out.normalize();
}

/**
 * A shard of ice: a long six-sided point ahead, a short one behind, a faint
 * cold glow round it. Built along +y; `point` turns it to fly along a direction.
 */
class Shard {
  readonly group = new THREE.Group();
  /** Spins round its own length, so the facets catch the light. */
  private readonly body = new THREE.Group();
  private readonly glow = glowSprite(0x6fc8ff, 0.35);
  private readonly spin = (Math.random() < 0.5 ? -1 : 1) * (8 + 4 * Math.random());

  constructor(parent: THREE.Object3D, length: number, width: number) {
    const front = length * 0.75;
    const back = length - front;
    const tip = new THREE.Mesh(new THREE.ConeGeometry(width, front, 6).translate(0, front / 2, 0), iceMaterial());
    const tail = new THREE.Mesh(new THREE.ConeGeometry(width, back, 6).rotateX(Math.PI).translate(0, -back / 2, 0), iceMaterial());
    this.body.add(tip, tail);
    this.glow.scale.setScalar(width * 6);
    this.glow.position.y = front * 0.25;
    this.group.add(this.body, this.glow);
    parent.add(this.group);
  }

  /** Points the tip along `direction` (world space, unit length). */
  point(direction: THREE.Vector3) {
    this.group.quaternion.setFromUnitVectors(UP, direction);
  }

  update(time: number) {
    this.body.rotation.y = time * this.spin;
  }

  dispose() {
    disposeGroup(this.group);
  }
}

/** Frost a shard in flight leaves behind it, melting away where it fell. */
class Trail {
  private readonly group = new THREE.Group();
  private readonly motes = Array.from({ length: TRAIL_MOTES }, () => ({ sprite: glowSprite(0xbfe6ff), age: Infinity }));
  private next = 0;
  private sinceDrop = Infinity;

  constructor(parent: THREE.Object3D) {
    for (const { sprite } of this.motes) { this.group.add(sprite); }
    parent.add(this.group);
  }

  /** Drops a mote where the shard now is, when one is due, and fades the rest. */
  update(dt: number, at: THREE.Vector3) {
    this.sinceDrop += dt;
    if (this.sinceDrop >= TRAIL_EVERY_S) {
      this.sinceDrop = 0;
      const mote = this.motes[this.next];
      this.next = (this.next + 1) % TRAIL_MOTES;
      mote.age = 0;
      mote.sprite.position.copy(at);
    }
    for (const mote of this.motes) {
      const k = mote.age / TRAIL_LIFE_S;
      mote.age += dt;
      mote.sprite.visible = k < 1;
      if (k >= 1) { continue; }
      mote.sprite.scale.setScalar(RADIUS * (0.5 + 1.5 * (1 - k)));
      mote.sprite.material.color.lerpColors(FROST_BRIGHT, FROST_DEEP, k);
      mote.sprite.material.opacity = 0.55 * (1 - k) ** 1.5;
    }
  }

  dispose() {
    disposeGroup(this.group);
  }
}

/** A shard in flight, flown here along the server's path from its launch. */
interface Flying {
  shard: Shard;
  trail: Trail;
  launch: WhipShardLaunch;
  /** performance.now() when it was thrown here: the click for your own, the cast's arrival for others'. */
  startedAt: number;
  /** World-space gap from the true position to where we drew it leaving, closed over BLEND_S; zero for others'. */
  launchOffset: THREE.Vector3;
  /** Where it is flying, in world space: which way it shatters back from a body. */
  direction: THREE.Vector3;
  lastFrame: number;
}

/**
 * Outward normal of the surface a shard shattered against, in world space:
 * the floor or one of the four arena walls (the server clamps the point onto
 * it); null if it was none of them — a raised wall.
 */
function surfaceNormal(p: WhipShardPoint, out: THREE.Vector3): THREE.Vector3 | null {
  const r = WHIP_SHARD.radius + 0.01;
  if (p.z <= r) { return out.set(0, 1, 0); }
  if (p.x <= r) { return out.set(1, 0, 0); }
  if (p.x >= ARENA_WIDTH - r) { return out.set(-1, 0, 0); }
  if (p.y <= r) { return out.set(0, 0, 1); }
  if (p.y >= ARENA_HEIGHT - r) { return out.set(0, 0, -1); }
  return null;
}

/**
 * What everyone sees where a shard shatters: a cold flash, a puff of frost,
 * splinters of ice bursting back off what it hit and falling, and — on the
 * floor — a patch of frost that melts away.
 */
class ShatterEffect implements Effect {
  private readonly group = new THREE.Group();
  private readonly flash = glowSprite(0xd8f4ff);
  private readonly mist = glowSprite(0x6fc8ff);
  private readonly frost = glowMaterial(0xbfe6ff);
  private readonly splinters: { mesh: THREE.Mesh<THREE.TetrahedronGeometry, THREE.MeshStandardMaterial>; velocity: THREE.Vector3; spin: THREE.Vector3 }[] = [];
  private readonly onGround: boolean;
  private elapsed = 0;

  /** `normal` is which way the splinters burst: off the surface, or back toward the thrower off a body. */
  constructor(parent: THREE.Object3D, at: WhipShardPoint, normal: THREE.Vector3) {
    toWorldPoint(at, this.group.position);
    this.group.add(this.flash, this.mist);

    const side = new THREE.Vector3();
    const across = new THREE.Vector3();
    side.crossVectors(normal, Math.abs(normal.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : UP).normalize();
    across.crossVectors(normal, side);
    for (let i = 0; i < SPLINTERS; i++) {
      const mesh = new THREE.Mesh(new THREE.TetrahedronGeometry(SHARD_WIDTH * (0.5 + Math.random())), iceMaterial());
      mesh.scale.set(1, 2 + Math.random() * 2, 1);
      // Out in a wide cone round the normal.
      const angle = Math.random() * Math.PI * 2;
      const spread = 0.4 + Math.random() * 0.9;
      const velocity = normal.clone()
        .addScaledVector(side, Math.cos(angle) * spread)
        .addScaledVector(across, Math.sin(angle) * spread)
        .normalize()
        .multiplyScalar(SPLINTER_SPEED * (0.4 + Math.random()));
      const spin = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(30);
      this.group.add(mesh);
      this.splinters.push({ mesh, velocity, spin });
    }

    // Floor marks sit on the floor, however high it shattered.
    this.onGround = at.z <= WHIP_SHARD.radius + 1;
    if (this.onGround) {
      this.group.add(onFloor(new THREE.Mesh(new THREE.CircleGeometry(RADIUS * 3, 32), this.frost), 0.015 - this.group.position.y));
    }
    parent.add(this.group);
  }

  update(dt: number) {
    const t = (this.elapsed += dt);
    const k = Math.min(t / SHATTER_S, 1);

    // Flash: a cold pop, gone by 0.15 s; frost billows out and thins by 0.5 s.
    this.flash.scale.setScalar(RADIUS * (2 + 4 * Math.min(t / 0.06, 1)));
    this.flash.material.opacity = Math.max(0, 1 - t / 0.15);
    const puff = Math.min(t / 0.5, 1);
    this.mist.scale.setScalar(RADIUS * (3 + 5 * (1 - (1 - puff) ** 2)));
    this.mist.material.opacity = 0.5 * (1 - puff) ** 1.5;

    for (const { mesh, velocity, spin } of this.splinters) {
      velocity.y -= SPLINTER_GRAVITY * dt;
      mesh.position.addScaledVector(velocity, dt);
      // Never through the floor: they skid along it.
      const floor = -this.group.position.y;
      if (mesh.position.y < floor) {
        mesh.position.y = floor;
        velocity.y = 0;
        velocity.multiplyScalar(0.8);
      }
      mesh.rotation.x += spin.x * dt;
      mesh.rotation.y += spin.y * dt;
      mesh.rotation.z += spin.z * dt;
      mesh.material.opacity = 0.9 * (1 - k * k);
    }

    // Frost patch: lingers, then melts by 1.5 s.
    this.frost.opacity = 0.35 * Math.min(t / 0.05, 1) * Math.max(0, 1 - Math.max(0, t - 0.5) / 1);

    return t < (this.onGround ? 1.5 : SHATTER_S);
  }

  dispose() {
    disposeGroup(this.group);
  }
}

/**
 * Water Whip's shards, for everyone: the third hit's shard of ice in
 * flight, and where it shatters. `WaterWhipController` throws your own on
 * the click (`throwOwn`) and takes it back if the server says that hit was
 * a lash after all (`dropOwn`); everyone else's — players' and anything
 * else that cracks a whip — come from `whipShardCast`.
 *
 * Positions in flight are never synced: each shard flies here from its
 * launch, and only where it shatters comes from the server. Someone else's
 * starts when their cast arrives; the shatter arrives just as late, so it
 * breaks about where it is drawn. Your own leaves on the click, about one
 * round trip ahead of the server's — at high latency it may fly on a little
 * past what it hit before the shatter arrives.
 */
export class WhipShards {
  /** Shards in the air, by server id. */
  private readonly flying = new Map<number, Flying>();
  /**
   * Your own shard, thrown on the click and not yet confirmed. Hits wait for
   * their confirmation, so there is at most one; the next shard cast for us
   * is its confirmation.
   */
  private pending: Flying | undefined;
  private readonly normal = new THREE.Vector3();

  constructor(
    private readonly room: ArenaRoom,
    private readonly scene: ArenaScene,
    private readonly effects: Effects,
  ) {
    room.onMessage(SERVER_MESSAGE.whipShardCast, (msg: WhipShardCast) => {
      const now = performance.now();
      if (msg.casterId !== room.sessionId) {
        this.flying.set(msg.id, this.throw(msg, now, false));
        return;
      }
      // Ours has been flying since the click: from now on it goes by the
      // server's id. Confirmed after we gave up on it: throw it now instead.
      this.flying.set(msg.id, this.pending ?? this.throw(msg, now, false));
      this.pending = undefined;
    });

    // Shattered at the server's point, wherever we were drawing it.
    room.onMessage(SERVER_MESSAGE.whipShardHit, (msg: WhipShardHit) => {
      const flying = this.flying.get(msg.id);
      this.flying.delete(msg.id);
      const surface = msg.hitId === undefined ? surfaceNormal(msg, this.normal) : null;
      if (!surface) {
        // Off a body or a raised wall: back the way it came.
        if (flying) { this.normal.copy(flying.direction).negate(); } else { this.normal.copy(UP); }
      }
      if (flying) { this.drop(flying); }
      this.effects.add(new ShatterEffect(scene.scene, msg, this.normal));
    });
  }

  /** Click: your own shard leaves at once, from just below the middle of the view, onto the server's path. */
  throwOwn(launch: WhipShardLaunch) {
    if (this.pending) { this.drop(this.pending); }
    this.pending = this.throw(launch, performance.now(), true);
  }

  /** Your own shard on the click wasn't one after all — refused, or the server's combo had another hit due. */
  dropOwn() {
    if (this.pending) { this.drop(this.pending); }
    this.pending = undefined;
  }

  /** A shard leaving at `startedAt`: your own from where you see it leave, anyone else's from their launch point. */
  private throw(launch: WhipShardLaunch, startedAt: number, own: boolean): Flying {
    const shard = new Shard(this.scene.scene, SHARD_LENGTH, SHARD_WIDTH);
    const launchOffset = new THREE.Vector3();
    if (own) {
      this.scene.camera.updateMatrixWorld();
      this.scene.camera.localToWorld(launchOffset.copy(VIEW_LAUNCH)).sub(toWorldPoint(whipShardPosition(launch, 0), shard.group.position));
    }
    const direction = toWorldDirection(whipShardVelocity(launch, 0), new THREE.Vector3());
    return { shard, trail: new Trail(this.scene.scene), launch: { ...launch }, startedAt, launchOffset, direction, lastFrame: startedAt };
  }

  /** Moves a shard to where it is now, tip first; false once it has melted. */
  private fly(flying: Flying, now: number) {
    const { shard, launch, launchOffset } = flying;
    const age = (now - flying.startedAt) / 1000;
    if (age * 1000 >= WHIP_SHARD.lifetimeMs) { return false; }
    const dt = Math.max(0, (now - flying.lastFrame) / 1000);
    flying.lastFrame = now;

    const position = toWorldPoint(whipShardPosition(launch, age), shard.group.position)
      .addScaledVector(launchOffset, Math.max(0, 1 - age / BLEND_S));
    shard.point(toWorldDirection(whipShardVelocity(launch, age), flying.direction));
    shard.update(now / 1000);
    flying.trail.update(dt, position);
    return true;
  }

  private drop(flying: Flying) {
    flying.shard.dispose();
    flying.trail.dispose();
  }

  /** Per frame: shards in flight. Melted in the air without touching anything: the server sends nothing for that. */
  update(now: number) {
    for (const [id, flying] of this.flying) {
      if (!this.fly(flying, now)) {
        this.drop(flying);
        this.flying.delete(id);
      }
    }
    if (this.pending && !this.fly(this.pending, now)) { this.dropOwn(); }
  }

  /** A fresh round (`arenaReset`): no shards in the air — the server dropped them all. */
  reset() {
    this.flying.forEach((flying) => this.drop(flying));
    this.flying.clear();
    this.dropOwn();
  }
}
