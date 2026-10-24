import * as THREE from "three";
import {
  STONE_FISTS, fistPosition, launchFist, otherSide,
  type FistLaunch, type FistPoint, type FistSide, type StoneFistHit, type StoneFistPunched, type StonesAim,
} from "@ligma/backend/skills/stones/stonesConfig";
import { ARENA_WIDTH, ARENA_HEIGHT } from "@ligma/backend/shared/constants";
import { CLIENT_MESSAGE, SERVER_MESSAGE } from "@ligma/backend/shared/messages";
import { type ArenaScene, type Avatar, fromWorld, toWorld, WORLD_SCALE } from "../../render/scene";
import type { Showpiece, ShowpieceHolder } from "../showpiece";
import { type Effect, Effects, glowSprite, onFloor, disposeGroup } from "../../render/effects";
import type { ArenaRoom } from "../../net/arenaRoom";
import type { AbilitySlotUi } from "../../hud/hud";

/** The server's hit radius, in world units: the flying fist's size. */
const RADIUS = STONE_FISTS.radius * WORLD_SCALE;
/**
 * First person: the right fist at the bottom right of the view, where the
 * other elements' hands are too, the left mirrored at the bottom left (camera space).
 */
const VIEW_RIGHT = new THREE.Vector3(0.3, -0.26, -0.64);
const VIEW_FIST = 0.055;
/**
 * On others' bodies: where the server punches from — the side's hand, ahead
 * at chest height (world units, right of the avatar's centre; forward is -z).
 */
const BODY_RIGHT = new THREE.Vector3(STONE_FISTS.handSide, STONE_FISTS.handHeight, -STONE_FISTS.handAhead).multiplyScalar(WORLD_SCALE);
const BODY_FIST = RADIUS * 0.85;
/** How much held fists bob as they float, as a fraction of their size. */
const HOVER_BOB = 0.12;

/**
 * The punch, in seconds: the fist draws back from the hand over WINDUP_S,
 * then shoots out, settling onto its true path over BLEND_S. Drawn WINDUP_S
 * behind the server's path from then on — too little to see, and it keeps
 * the wind-up from eating into the reach.
 */
const WINDUP_S = 0.05;
const BLEND_S = 0.08;
/** How far it draws back, as a fraction of the size it leaves the hand at. */
const PULL = 1.6;
/** How far it rolls round its own line as it flies out (radians): a corkscrew punch. */
const ROLL = Math.PI / 2;

/**
 * A punched side's fist re-forms out of rock dust: it starts REFORM_DELAY_MS
 * after the punch and is whole REFORM_MS later — by 620 ms, before that side
 * is due again (two punch intervals, 800 ms).
 */
const REFORM_DELAY_MS = 120;
const REFORM_MS = 500;
const REFORM_PUFFS = 5;

/** If the server doesn't confirm a click this fast, treat it as refused (and take back what it drew). */
const CONFIRM_TIMEOUT_MS = 1500;
/** Dust shed by a fist in flight: how many puffs, how long each lasts, how often one drops. */
const TRAIL_PUFFS = 8;
const TRAIL_LIFE_S = 0.25;
const TRAIL_EVERY_S = 1 / 45;
/** Chunks thrown off where a fist breaks: how many, how long they last, how fast they fly. */
const CHUNKS = 12;
const BREAK_S = 0.8;
const CHUNK_SPEED = 4.5;
const CHUNK_GRAVITY = 14;

/** A few earth tones for stone, the lighter ones for the knuckles' worn faces, and the dust they shed. */
const ROCK_COLORS = [0x7a6248, 0x8a7a66, 0x6e5c4a, 0x9a8366];
const KNUCKLE_COLORS = [0xa08a6a, 0xb09872, 0x9a8366];
const DUST_COLOR = 0xa08a6a;
const UP = new THREE.Vector3(0, 1, 0);
/** Which way a fist's knuckles face in its own space. */
const FIST_FORWARD = new THREE.Vector3(0, 0, -1);

const clamp01 = (k: number) => Math.min(1, Math.max(0, k));
/** 0..1 eased out: fast at first, settling at the end. */
const easeOut = (k: number) => 1 - (1 - k) ** 3;
/** 0..1 eased in and out. */
const smooth = (k: number) => k * k * (3 - 2 * k);
const pick = (colors: number[]) => colors[Math.floor(Math.random() * colors.length)];

/** A point on the server's plane and height, in world space. */
function toWorldPoint(p: FistPoint, out: THREE.Vector3) {
  toWorld(p.x, p.y, out);
  out.y = p.z * WORLD_SCALE;
  return out;
}

/**
 * Pushes every corner of a shape a random little way, `amount` at most.
 * Corners shared by several faces move together, so it never cracks open.
 */
function roughen<G extends THREE.BufferGeometry>(geometry: G, amount: number): G {
  const position = geometry.getAttribute("position") as THREE.BufferAttribute;
  const corner = new THREE.Vector3();
  const moved = new Map<string, THREE.Vector3>();
  for (let i = 0; i < position.count; i++) {
    corner.fromBufferAttribute(position, i);
    const key = `${corner.x.toFixed(4)},${corner.y.toFixed(4)},${corner.z.toFixed(4)}`;
    let offset = moved.get(key);
    if (!offset) {
      offset = new THREE.Vector3().randomDirection().multiplyScalar(amount * Math.random());
      moved.set(key, offset);
    }
    position.setXYZ(i, corner.x + offset.x, corner.y + offset.y, corner.z + offset.z);
  }
  geometry.computeVertexNormals();
  return geometry;
}

/** Flat-shaded stone, its own material so every piece can be freed with its mesh. */
function stoneMesh(geometry: THREE.BufferGeometry, color: number) {
  return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color, roughness: 1, flatShading: true, transparent: true }));
}

/**
 * A fist of stone, about `size` from its centre to its knuckles, knuckles
 * facing -z: a squat block for the back of the hand, curled fingers under
 * a row of four worn knuckles, a thumb folded across from the inner side, and
 * a stub of wrist trailing behind. All roughened a little, so no two match.
 */
function createFist(size: number, side: FistSide) {
  const s = size;
  // The thumb is on the inside: the left of a right fist.
  const inner = side === "right" ? -1 : 1;
  const color = pick(ROCK_COLORS);
  const knuckle = pick(KNUCKLE_COLORS);
  const fist = new THREE.Group();

  const back = stoneMesh(roughen(new THREE.BoxGeometry(1.25 * s, 0.9 * s, 1.0 * s), 0.08 * s), color);
  back.position.set(0, 0.05 * s, 0.15 * s);
  const fingers = stoneMesh(roughen(new THREE.BoxGeometry(1.2 * s, 0.55 * s, 0.45 * s), 0.07 * s), color);
  fingers.position.set(0, -0.22 * s, -0.42 * s);
  fist.add(back, fingers);

  for (let i = 0; i < 4; i++) {
    const k = stoneMesh(roughen(new THREE.DodecahedronGeometry(0.22 * s, 0), 0.04 * s), knuckle);
    // The middle two stand a little proud of the outer two.
    k.position.set((i - 1.5) * 0.3 * s, (0.2 - 0.04 * Math.abs(i - 1.5)) * s, -0.5 * s);
    fist.add(k);
  }

  // From the inner side, folded forward and across the curled fingers.
  const thumb = stoneMesh(roughen(new THREE.BoxGeometry(0.32 * s, 0.3 * s, 0.65 * s), 0.05 * s), knuckle);
  thumb.position.set(inner * 0.5 * s, -0.32 * s, -0.25 * s);
  thumb.rotation.set(0.15, inner * 0.65, 0);

  const wrist = stoneMesh(roughen(new THREE.CylinderGeometry(0.36 * s, 0.28 * s, 0.55 * s, 6), 0.06 * s), color);
  wrist.rotation.x = Math.PI / 2;
  wrist.position.set(0, -0.02 * s, 0.85 * s);
  fist.add(thumb, wrist);
  return fist;
}

/**
 * A rough rock, for the chunks a fist breaks into: a twelve-faced ball with
 * every corner pushed in or out a little, in one of the earth tones.
 */
function createChunk(radius: number) {
  const rock = stoneMesh(roughen(new THREE.DodecahedronGeometry(radius, 0), radius * 0.3), pick(ROCK_COLORS));
  rock.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
  return rock;
}

/** A random tumble, in radians per second round each axis. */
function randomSpin(speed: number) {
  return new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(speed);
}

function tumble(mesh: THREE.Object3D, spin: THREE.Vector3, dt: number) {
  mesh.rotation.x += spin.x * dt;
  mesh.rotation.y += spin.y * dt;
  mesh.rotation.z += spin.z * dt;
}

/** A soft puff of dust: the glow sprite, blended normally so it reads as dust rather than light. */
function dustSprite(color = DUST_COLOR) {
  const sprite = glowSprite(color);
  sprite.material.blending = THREE.NormalBlending;
  return sprite;
}

/**
 * One fist floating at an earth mage's side. Punched, it's gone — the one in
 * flight is drawn instead — and a moment later it re-forms where it was,
 * growing back out of a swirl of rock dust.
 */
class HeldFist {
  readonly group = new THREE.Group();
  private readonly fist: THREE.Group;
  private readonly dust = Array.from({ length: REFORM_PUFFS }, () => dustSprite());
  /** performance.now() of its last punch; -Infinity while whole. */
  private punchedAt = -Infinity;
  private readonly phase = Math.random() * 10;

  constructor(parent: THREE.Object3D, at: THREE.Vector3, private readonly size: number, side: FistSide) {
    this.fist = createFist(size, side);
    this.group.position.copy(at);
    this.group.add(this.fist, ...this.dust);
    parent.add(this.group);
  }

  /** Whether it's whole: what a punch from this side leaves from. */
  formed(now: number) {
    return now - this.punchedAt >= REFORM_DELAY_MS + REFORM_MS;
  }

  punch(now: number) {
    this.punchedAt = now;
  }

  /** Whole again at once: a punch that never happened, or a fresh round. */
  restore() {
    this.punchedAt = -Infinity;
  }

  /** Where the fist floats, in world space. */
  worldPosition(out: THREE.Vector3) {
    return this.group.getWorldPosition(out);
  }

  update(now: number) {
    const t = now / 1000 + this.phase;
    const k = clamp01((now - this.punchedAt - REFORM_DELAY_MS) / REFORM_MS);
    const s = this.size;

    this.fist.visible = k > 0;
    this.fist.scale.setScalar(0.2 + 0.8 * easeOut(k));
    this.fist.position.y = HOVER_BOB * s * Math.sin(t * 2.4);
    this.fist.rotation.z = 0.08 * Math.sin(t * 1.7);

    // Dust swirling in onto it as it forms, thinning away once it's whole.
    const swirl = Math.sin(Math.PI * k);
    this.dust.forEach((sprite, i) => {
      const angle = (i / REFORM_PUFFS) * Math.PI * 2 + t * 4;
      const out = s * (2 - 1.2 * k);
      sprite.visible = swirl > 0.01;
      sprite.position.set(Math.cos(angle) * out, Math.sin(angle * 1.3) * s * 0.5, Math.sin(angle) * out);
      sprite.scale.setScalar(s * (2.2 - 0.8 * k));
      sprite.material.opacity = 0.45 * swirl;
    });
  }

  dispose() {
    disposeGroup(this.group);
  }
}

/** Both of an earth mage's fists, right and left of `right` mirrored. */
class FistPair {
  readonly group = new THREE.Group();
  private readonly fists: Record<FistSide, HeldFist>;

  constructor(parent: THREE.Object3D, right: THREE.Vector3, size: number) {
    this.fists = {
      right: new HeldFist(this.group, right, size, "right"),
      left: new HeldFist(this.group, new THREE.Vector3(-right.x, right.y, right.z), size, "left"),
    };
    parent.add(this.group);
  }

  fist(side: FistSide) {
    return this.fists[side];
  }

  restore() {
    this.fists.right.restore();
    this.fists.left.restore();
  }

  update(now: number) {
    this.fists.right.update(now);
    this.fists.left.update(now);
  }

  dispose() {
    disposeGroup(this.group);
  }
}

/** Dust a fist in flight sheds behind it. */
class Trail {
  private readonly group = new THREE.Group();
  private readonly puffs = Array.from({ length: TRAIL_PUFFS }, () => ({ sprite: dustSprite(), age: Infinity }));
  private next = 0;
  private sinceDrop = Infinity;

  constructor(parent: THREE.Object3D) {
    for (const { sprite } of this.puffs) { this.group.add(sprite); }
    parent.add(this.group);
  }

  /** Drops a puff where the fist now is, when one is due, and fades the rest. */
  update(dt: number, at: THREE.Vector3) {
    this.sinceDrop += dt;
    if (this.sinceDrop >= TRAIL_EVERY_S) {
      this.sinceDrop = 0;
      const puff = this.puffs[this.next];
      this.next = (this.next + 1) % TRAIL_PUFFS;
      puff.age = 0;
      puff.sprite.position.copy(at);
    }
    for (const puff of this.puffs) {
      const k = puff.age / TRAIL_LIFE_S;
      puff.age += dt;
      puff.sprite.visible = k < 1;
      if (k >= 1) { continue; }
      puff.sprite.scale.setScalar(RADIUS * (1 + 1.5 * k));
      puff.sprite.material.opacity = 0.3 * (1 - k) ** 1.5;
    }
  }

  dispose() {
    disposeGroup(this.group);
  }
}

/** A fist in flight, flown here along the server's path from its launch. */
interface Flying {
  fist: THREE.Group;
  trail: Trail;
  launch: FistLaunch;
  /** performance.now() when it was punched here: the click for your own, the punch's arrival for others'. */
  startedAt: number;
  /** World-space gap from the true launch point to the held fist it left, closed as it shoots out; zero if we drew none. */
  launchOffset: THREE.Vector3;
  /** Its size as it leaves that held fist, as a fraction of full; grows to full as it shoots out. */
  launchScale: number;
  /** Where it is flying, in world space (unit length): which way it breaks back from a body or a raised wall. */
  direction: THREE.Vector3;
  /** Which way it rolls as it flies out: the two hands corkscrew opposite ways. */
  roll: number;
  lastFrame: number;
}

/**
 * Outward normal of the arena surface a fist broke against, in world space:
 * the floor or one of the four walls (the server clamps the point onto it).
 * Null if it broke on something else — a body or a raised wall.
 */
function surfaceNormal(p: FistPoint, out: THREE.Vector3) {
  const r = STONE_FISTS.radius + 0.01;
  if (p.z <= r) { return out.set(0, 1, 0); }
  if (p.x <= r) { return out.set(1, 0, 0); }
  if (p.x >= ARENA_WIDTH - r) { return out.set(-1, 0, 0); }
  if (p.y <= r) { return out.set(0, 0, 1); }
  if (p.y >= ARENA_HEIGHT - r) { return out.set(0, 0, -1); }
  return null;
}

/**
 * What everyone sees where a fist cracks apart: a burst of dust, chunks of
 * stone bursting back off what it hit, tumbling and skidding along the floor,
 * and — on the floor — a scuff of dust that settles.
 */
class CrackEffect implements Effect {
  private readonly group = new THREE.Group();
  private readonly dust = Array.from({ length: 4 }, () => dustSprite());
  private readonly scuff = new THREE.MeshBasicMaterial({ color: 0x6e5c4a, transparent: true, opacity: 0, depthWrite: false });
  private readonly chunks: { mesh: THREE.Mesh; velocity: THREE.Vector3; spin: THREE.Vector3 }[] = [];
  private readonly onGround: boolean;
  private elapsed = 0;

  /** `normal` is which way the chunks burst: off the surface, or back toward the puncher. */
  constructor(parent: THREE.Object3D, at: FistPoint, normal: THREE.Vector3) {
    toWorldPoint(at, this.group.position);
    this.dust.forEach((sprite, i) => {
      sprite.position.copy(normal).multiplyScalar(RADIUS * 0.5 * i).add(new THREE.Vector3().randomDirection().multiplyScalar(RADIUS * 0.4));
      this.group.add(sprite);
    });

    const side = new THREE.Vector3().crossVectors(normal, Math.abs(normal.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : UP).normalize();
    const across = new THREE.Vector3().crossVectors(normal, side);
    for (let i = 0; i < CHUNKS; i++) {
      const mesh = createChunk(RADIUS * (0.15 + Math.random() * 0.25));
      // Out in a wide cone round the normal.
      const angle = Math.random() * Math.PI * 2;
      const spread = 0.5 + Math.random() * 0.9;
      const velocity = normal.clone()
        .addScaledVector(side, Math.cos(angle) * spread)
        .addScaledVector(across, Math.sin(angle) * spread)
        .normalize()
        .multiplyScalar(CHUNK_SPEED * (0.4 + Math.random()));
      this.group.add(mesh);
      this.chunks.push({ mesh, velocity, spin: randomSpin(20) });
    }

    // Floor marks sit on the floor, however high it broke.
    this.onGround = at.z <= STONE_FISTS.radius + 1;
    if (this.onGround) {
      this.group.add(onFloor(new THREE.Mesh(new THREE.CircleGeometry(RADIUS * 2.5, 24), this.scuff), 0.015 - this.group.position.y));
    }
    parent.add(this.group);
  }

  update(dt: number) {
    const t = (this.elapsed += dt);
    const k = Math.min(t / BREAK_S, 1);

    // Dust: billows out fast, then thins away.
    const puff = Math.min(t / 0.5, 1);
    this.dust.forEach((sprite, i) => {
      sprite.scale.setScalar(RADIUS * (2 + 4 * easeOut(puff)) * (1 + 0.2 * i));
      sprite.material.opacity = 0.55 * (1 - puff) ** 1.5;
    });

    for (const { mesh, velocity, spin } of this.chunks) {
      velocity.y -= CHUNK_GRAVITY * dt;
      mesh.position.addScaledVector(velocity, dt);
      // Never through the floor: they skid along it, slowing.
      const floor = -this.group.position.y;
      if (mesh.position.y < floor) {
        mesh.position.y = floor;
        velocity.y = 0;
        velocity.multiplyScalar(0.7);
        spin.multiplyScalar(0.7);
      }
      tumble(mesh, spin, dt);
      (mesh.material as THREE.MeshStandardMaterial).opacity = 1 - clamp01((k - 0.6) / 0.4);
    }

    // Scuff: appears at once, settles away by 1.5 s.
    this.scuff.opacity = 0.35 * Math.max(0, 1 - Math.max(0, t - 0.5) / 1);

    return t < (this.onGround ? 1.5 : BREAK_S);
  }

  dispose() {
    disposeGroup(this.group);
  }
}

/**
 * Client side of Stone Fists, earth's main skill: two stone fists float at
 * your sides — in first person at the bottom left and right of the view, on
 * everyone else beside their chest — and each click punches one along the
 * view, right then left. Draws everyone's fists, the punches in flight, where
 * they crack apart, and the slot display (the short wait between punches).
 * The server decides everything that matters (timing, which hand, path, who
 * is struck). `slot` is null when Stone Fists isn't in our kit: then only
 * other earth mages' fists are drawn.
 *
 * Positions in flight are never synced: each fist flies here from its
 * launch, and only where it breaks comes from the server. Your own punches
 * are drawn on the click, about one round trip ahead of the server.
 */
export class StonesController {
  private readonly own: FistPair;
  private readonly hands = new Map<string, FistPair>();
  /** Fists in the air, by server id. */
  private readonly flying = new Map<number, Flying>();
  /**
   * Your own punch, drawn on the click and not yet confirmed. Clicks wait for
   * their confirmation, so there is at most one; the next punch message for
   * us is its confirmation. `flying` is null once it has already crumbled.
   */
  private pending: { flying: Flying | null; side: FistSide } | undefined;
  /** Which hand we expect the server to punch next: it says, and we follow. */
  private nextSide: FistSide = "right";
  /** performance.now() when the next click is allowed; Infinity while awaiting confirmation. */
  private readyAt = 0;
  private cooldownEndsAt = 0;
  private confirmTimer = 0;
  private readonly launchAt = new THREE.Vector3();
  private readonly normal = new THREE.Vector3();
  private readonly roll = new THREE.Quaternion();

  constructor(
    private readonly room: ArenaRoom,
    private readonly scene: ArenaScene,
    private readonly effects: Effects,
    private readonly slot: AbilitySlotUi | null,
  ) {
    this.own = new FistPair(scene.camera, VIEW_RIGHT, VIEW_FIST);
    this.own.group.visible = false;

    room.onMessage(SERVER_MESSAGE.stoneFistPunched, (msg: StoneFistPunched) => {
      const now = performance.now();
      if (msg.casterId !== room.sessionId) {
        // It leaves from that side's fist, if it was whole to leave.
        const held = this.hands.get(msg.casterId)?.fist(msg.side);
        const origin = held?.formed(now) ? held.worldPosition(this.launchAt) : null;
        held?.punch(now);
        this.flying.set(msg.id, this.punch(msg, msg.side, now, origin, BODY_FIST));
        return;
      }

      clearTimeout(this.confirmTimer);
      // Counting from arrival keeps us a little *behind* the server, so a
      // punch is never sent early and silently refused.
      this.cooldownEndsAt = now + msg.cooldownMs;
      this.readyAt = this.cooldownEndsAt;
      this.nextSide = otherSide(msg.side);
      const pending = this.pending;
      this.pending = undefined;
      if (pending && pending.side !== msg.side) {
        // We guessed the wrong hand: the other one went.
        this.own.fist(pending.side).restore();
        this.own.fist(msg.side).punch(now);
      }
      // Ours has been flying since the click: from now on it goes by the
      // server's id. Confirmed after we gave up on it: punch it now instead.
      if (pending) {
        if (pending.flying) { this.flying.set(msg.id, pending.flying); }
      } else {
        this.own.fist(msg.side).punch(now);
        this.flying.set(msg.id, this.punch(msg, msg.side, now, null, RADIUS));
      }
    });

    // Cracked apart at the server's point, wherever we were drawing it.
    room.onMessage(SERVER_MESSAGE.stoneFistHit, (msg: StoneFistHit) => {
      const flying = this.flying.get(msg.id);
      this.flying.delete(msg.id);
      // Off a body or a raised wall: back the way it came.
      if (msg.hitId !== undefined || !surfaceNormal(msg, this.normal)) {
        if (flying) { this.normal.copy(flying.direction).negate(); } else { this.normal.copy(UP); }
      }
      if (flying) { this.drop(flying); }
      this.effects.add(new CrackEffect(scene.scene, msg, this.normal));
    });
  }

  get ready() {
    return performance.now() >= this.readyAt;
  }

  /**
   * Click: punch the next fist along our facing. `from` is our predicted
   * position, where the server will punch it from too.
   */
  cast(yaw: number, from: FistPoint) {
    if (!this.slot || !this.ready) { return; }
    const aim: StonesAim = { yaw };
    this.room.send(CLIENT_MESSAGE.stones, aim);

    // It leaves the fist you see, by the server's own launch rule.
    const now = performance.now();
    const side = this.nextSide;
    const held = this.own.fist(side);
    const origin = held.formed(now) ? held.worldPosition(this.launchAt) : null;
    held.punch(now);
    this.pending = { flying: this.punch(launchFist(from, aim, side), side, now, origin, VIEW_FIST), side };
    this.nextSide = otherSide(side);

    // No double-sends while the server decides; give up waiting after a while.
    this.readyAt = Infinity;
    this.cooldownEndsAt = now + STONE_FISTS.punchIntervalMs;
    clearTimeout(this.confirmTimer);
    this.confirmTimer = window.setTimeout(() => this.refused(), CONFIRM_TIMEOUT_MS);
  }

  /** The server never answered our click: take back what it drew. */
  private refused() {
    if (this.pending) {
      this.own.fist(this.pending.side).restore();
      this.nextSide = this.pending.side;
      if (this.pending.flying) { this.drop(this.pending.flying); }
    }
    this.pending = undefined;
    this.readyAt = 0;
    this.cooldownEndsAt = 0;
  }

  /** A remote earth mage: their fists float at their sides, ahead at chest height. */
  addHand(sessionId: string, avatar: Avatar) {
    this.hands.set(sessionId, new FistPair(avatar.group, BODY_RIGHT, BODY_FIST));
  }

  /** The avatar is going away. */
  removeHand(sessionId: string) {
    this.hands.get(sessionId)?.dispose();
    this.hands.delete(sessionId);
  }

  /**
   * A fist punched at `startedAt` by the `side` hand — from `origin` (world
   * space), the held fist of `originSize` it was, if we drew one — onto its true path.
   */
  private punch(launch: FistLaunch, side: FistSide, startedAt: number, origin: THREE.Vector3 | null, originSize: number): Flying {
    const fist = createFist(RADIUS, side);
    this.scene.scene.add(fist);
    const launchOffset = new THREE.Vector3();
    if (origin) { launchOffset.copy(origin).sub(toWorldPoint(fistPosition(launch, 0), fist.position)); }
    const direction = new THREE.Vector3(launch.vx, launch.vz, launch.vy);
    if (direction.lengthSq() < 1e-9) { direction.set(0, 0, -1); }
    direction.normalize();
    fist.quaternion.setFromUnitVectors(FIST_FORWARD, direction);
    return {
      fist,
      trail: new Trail(this.scene.scene),
      launch: { x: launch.x, y: launch.y, z: launch.z, vx: launch.vx, vy: launch.vy, vz: launch.vz },
      startedAt,
      launchOffset,
      launchScale: origin ? originSize / RADIUS : 1,
      direction,
      roll: side === "right" ? -ROLL : ROLL,
      lastFrame: startedAt,
    };
  }

  /**
   * Moves a fist to where it is now; false once its reach is spent. For the
   * first WINDUP_S it draws back from the hand; then it shoots out, catching
   * up with its true path over BLEND_S, rolling as it goes.
   */
  private fly(flying: Flying, now: number) {
    const { fist, launch, launchOffset, launchScale, direction } = flying;
    const age = (now - flying.startedAt) / 1000;
    const out = Math.max(0, age - WINDUP_S);
    if (out * 1000 >= STONE_FISTS.lifetimeMs) { return false; }
    const dt = Math.max(0, (now - flying.lastFrame) / 1000);
    flying.lastFrame = now;

    const shot = smooth(clamp01(out / BLEND_S));
    const draw = age < WINDUP_S ? easeOut(age / WINDUP_S) : 1 - shot;
    const position = toWorldPoint(fistPosition(launch, out), fist.position)
      .addScaledVector(launchOffset, 1 - shot)
      .addScaledVector(direction, -PULL * RADIUS * launchScale * draw);
    fist.scale.setScalar(launchScale + (1 - launchScale) * shot);
    fist.quaternion.setFromUnitVectors(FIST_FORWARD, direction)
      .multiply(this.roll.setFromAxisAngle(FIST_FORWARD, flying.roll * shot));
    if (out > 0) { flying.trail.update(dt, position); }
    return true;
  }

  private drop(flying: Flying) {
    disposeGroup(flying.fist);
    flying.trail.dispose();
  }

  /** A punch spent its reach without touching anything (the server sends nothing for that): it crumbles where it is. */
  private crumble(flying: Flying) {
    const p = flying.fist.position;
    const at = { ...fromWorld(p.x, p.z), z: p.y / WORLD_SCALE };
    this.effects.add(new CrackEffect(this.scene.scene, at, this.normal.copy(flying.direction).negate()));
    this.drop(flying);
  }

  /**
   * Per frame, after the camera moves: the fists, ours and everyone else's,
   * punches in flight, and the slot display. `selected` is whether Stone
   * Fists is the active skill; `alive` shows your own.
   */
  update(selected: boolean, alive: boolean) {
    const now = performance.now();

    this.own.group.visible = this.slot !== null && alive;
    this.own.update(now);
    for (const [sessionId, hand] of this.hands) {
      const player = this.room.state.players.get(sessionId);
      hand.group.visible = player !== undefined && player.hp > 0;
      hand.update(now);
    }

    for (const [id, flying] of this.flying) {
      if (!this.fly(flying, now)) {
        this.crumble(flying);
        this.flying.delete(id);
      }
    }
    // Spent before the server confirmed it: still the click awaiting its answer, with nothing left to draw.
    if (this.pending?.flying && !this.fly(this.pending.flying, now)) {
      this.crumble(this.pending.flying);
      this.pending.flying = null;
    }

    this.showSlot(selected, Math.max(0, this.cooldownEndsAt - now));
  }

  /** The wait before the next punch, while it runs. */
  private showSlot(selected: boolean, remaining: number) {
    if (!this.slot) { return; }
    this.slot.root.classList.toggle("armed", selected);
    this.slot.root.classList.toggle("cooling", remaining > 0);
    this.slot.root.style.setProperty("--cooldown", String(Math.min(1, remaining / STONE_FISTS.punchIntervalMs)));
    this.slot.cooldownText.textContent = remaining > 0 ? (remaining / 1000).toFixed(1) : "";
  }

  /**
   * A fresh round (`arenaReset`): both fists whole, right first, ready right
   * away, nothing in the air — the server dropped it all.
   */
  reset() {
    clearTimeout(this.confirmTimer);
    this.flying.forEach((flying) => this.drop(flying));
    this.flying.clear();
    if (this.pending?.flying) { this.drop(this.pending.flying); }
    this.pending = undefined;
    this.nextSide = "right";
    this.readyAt = 0;
    this.cooldownEndsAt = 0;
    this.own.restore();
    this.hands.forEach((hand) => hand.restore());
  }

  dispose() {
    this.reset();
    this.own.dispose();
    this.hands.forEach((hand) => hand.dispose());
    this.hands.clear();
    this.showSlot(false, 0);
  }
}

/** Both stone fists floating at the sides: the lobby's earth mage. */
export function createStonesShowpiece(holder: ShowpieceHolder): Showpiece {
  const fists = new FistPair(holder.group, BODY_RIGHT, BODY_FIST);
  return {
    update: (now) => fists.update(now),
    dispose: () => fists.dispose(),
  };
}
