import * as THREE from "three";
import {
  FIREBALL, fireballLanding, fireballPosition, launchFireball,
  type FireballAim, type FireballCast, type FireballHit, type FireballLaunch, type FireballPoint,
} from "@ligma/backend/skills/fireball/fireballConfig";
import { ARENA_WIDTH } from "@ligma/backend/shared/constants";
import { CLIENT_MESSAGE, SERVER_MESSAGE } from "@ligma/backend/shared/messages";
import { type ArenaScene, type Avatar, toWorld, WORLD_SCALE } from "../../render/scene";
import type { Showpiece, ShowpieceHolder } from "../showpiece";
import { type Effect, Effects, glowMaterial, glowSprite, onFloor, disposeGroup } from "../../render/effects";
import type { ArenaRoom } from "../../net/arenaRoom";
import type { AbilitySlotUi } from "../../hud/hud";

/** The flying ball, in world units: the server's hit sphere. */
const RADIUS = FIREBALL.radius * WORLD_SCALE;
/** The blast, in world units: who the server hurts. */
const BLAST_RADIUS = FIREBALL.blastRadius * WORLD_SCALE;
/** Held beside a remote player's body: a bit smaller than in flight. */
const HAND_RADIUS = RADIUS * 0.7;
/** First person: bottom right of the view, just ahead of the eyes (camera space). */
const VIEW_RADIUS = 0.07;
const VIEW_POSITION = new THREE.Vector3(0.36, -0.28, -0.8);
/** Size of a fireball that has only just started growing, as a fraction of full. */
const MIN_SCALE = 0.15;
/**
 * The catapult swing: a new ball is pulled back, whipped up over the top and
 * onto its true arc over this long — and the hand follows through as long.
 */
const SWING_S = 0.3;
/** How far the swing pulls a ball back and lifts it over, in world units. */
const SWING_PULL = 0.25;
const SWING_LIFT = 0.35;
/** If the server doesn't confirm a cast this fast, treat it as refused (and take back the ball thrown on the click). */
const CONFIRM_TIMEOUT_MS = 1500;
/** Points along the aim line. */
const LINE_POINTS = 48;
/** Flame tongues licking up off every ball. */
const TONGUES = 10;
/** Embers left behind a ball in flight: how many, how long each glows, how often one drops. */
const TRAIL_PUFFS = 18;
const TRAIL_LIFE_S = 0.3;
const TRAIL_EVERY_S = 1 / 60;

const FLAME_HOT = new THREE.Color(0xffe07a);
const FLAME_COOL = new THREE.Color(0xff3a10);
const WORLD_UP = new THREE.Vector3(0, 1, 0);

/**
 * A white-hot core in flickering glow, with tongues of flame rising off its
 * top — always up in the world, however the hand holding it is turned.
 */
class Orb {
  readonly group = new THREE.Group();
  private readonly flame = glowSprite(0xffa230);
  private readonly smoulder = glowSprite(0xff4a10);
  private readonly tongues = Array.from({ length: TONGUES }, (_, i) => ({
    sprite: glowSprite(0xffa230),
    /** Where around the top it rises from, and its own pace and phase. */
    angle: i * 2.39996,
    rate: 1.8 + Math.random() * 0.8,
    seed: Math.random(),
  }));
  /** Per-orb phase, so a room full of them doesn't flicker in lockstep. */
  private readonly phase = Math.random() * 100;
  private readonly up = new THREE.Vector3();
  private readonly side = new THREE.Vector3();
  private readonly across = new THREE.Vector3();
  private readonly turn = new THREE.Quaternion();

  constructor(parent: THREE.Object3D, private readonly radius: number) {
    const core = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.5, 16, 12), new THREE.MeshBasicMaterial({ color: 0xfff4c8 }));
    this.group.add(core, this.flame, this.smoulder, ...this.tongues.map((t) => t.sprite));
    parent.add(this.group);
  }

  /** `scale` sizes the whole ball; `heat` (0..1) brightens the glow and the flames. */
  update(time: number, scale: number, heat = 1) {
    const t = time + this.phase;
    const r = this.radius;
    this.group.scale.setScalar(scale);
    this.flame.scale.setScalar(r * (2 + 0.25 * Math.sin(t * 23) + 0.15 * Math.sin(t * 37)));
    this.smoulder.scale.setScalar(r * (3 + 0.35 * Math.sin(t * 17)));
    this.flame.material.opacity = (0.75 + 0.25 * heat) * (0.85 + 0.15 * Math.sin(t * 29));
    this.smoulder.material.opacity = 0.35 + 0.35 * heat;

    // World up, as seen from inside the group (the view's ball turns with the camera).
    this.group.getWorldQuaternion(this.turn).invert();
    this.up.copy(WORLD_UP).applyQuaternion(this.turn);
    this.side.set(1, 0, 0).applyQuaternion(this.turn).addScaledVector(this.up, -this.up.x).normalize();
    this.across.crossVectors(this.up, this.side);

    for (const tongue of this.tongues) {
      // Each tongue is born at the top of the ball, rises, thins and cools to red.
      const life = (t * tongue.rate + tongue.seed) % 1;
      const sway = 0.15 * Math.sin(t * 11 + tongue.seed * 20) * life;
      const { sprite } = tongue;
      sprite.position.copy(this.up).multiplyScalar(r * (0.25 + 2 * life))
        .addScaledVector(this.side, r * (0.35 * Math.cos(tongue.angle) * (1 - life) + sway))
        .addScaledVector(this.across, r * 0.35 * Math.sin(tongue.angle) * (1 - life));
      sprite.scale.setScalar(r * (0.25 + 1.4 * (1 - life) ** 0.7));
      sprite.material.color.lerpColors(FLAME_HOT, FLAME_COOL, life);
      sprite.material.opacity = (0.55 + 0.45 * heat) * Math.min(1, life / 0.08) * (1 - life) ** 1.3;
    }
  }

  dispose() {
    disposeGroup(this.group);
  }
}

/** Embers a ball in flight leaves behind it, glowing out where they fell. */
class Trail {
  private readonly group = new THREE.Group();
  private readonly puffs = Array.from({ length: TRAIL_PUFFS }, () => ({ sprite: glowSprite(0xff6a1a), age: Infinity }));
  private next = 0;
  private sinceDrop = Infinity;

  constructor(parent: THREE.Object3D) {
    for (const { sprite } of this.puffs) { this.group.add(sprite); }
    parent.add(this.group);
  }

  /** Drops an ember where the ball now is, when one is due, and fades the rest. */
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
      puff.sprite.scale.setScalar(RADIUS * (0.6 + 2 * (1 - k)));
      puff.sprite.material.color.lerpColors(FLAME_HOT, FLAME_COOL, k);
      puff.sprite.material.opacity = 0.7 * (1 - k) ** 1.5;
    }
  }

  dispose() {
    disposeGroup(this.group);
  }
}

/**
 * How far along the next fireball is: it grows from `startedAt` until
 * `readyAt` (performance.now() ms). Fully grown until a cast says otherwise.
 */
class Charge {
  startedAt = 0;
  readyAt = 0;

  restart(now: number, durationMs: number) {
    this.startedAt = now;
    this.readyAt = now + durationMs;
  }

  progress(now: number) {
    if (this.readyAt <= this.startedAt) { return 1; }
    return Math.min(1, Math.max(0, (now - this.startedAt) / (this.readyAt - this.startedAt)));
  }
}

/**
 * Ball size for a charge: grows steadily with the cooldown — so its size
 * *is* the cooldown — then pulses once fully grown.
 */
function chargeScale(progress: number, time: number) {
  if (progress >= 1) { return 1 + 0.08 * Math.sin(time * 9); }
  return MIN_SCALE + (1 - MIN_SCALE) * progress;
}

/** Shows a hand's charge on its orb; the halo flares up when ready. */
function showCharge(orb: Orb, charge: Charge, now: number) {
  const progress = charge.progress(now);
  orb.update(now / 1000, chargeScale(progress, now / 1000), progress >= 1 ? 1 : 0.4 * progress);
}

/** 0..1..0 over the swing after a throw at `thrownAt` (performance.now() ms): how far the hand follows through. */
function followThrough(thrownAt: number, now: number) {
  const u = (now - thrownAt) / 1000 / SWING_S;
  return u >= 0 && u < 1 ? Math.sin(Math.PI * u) : 0;
}

/** A fire mage's hand, holding their next fireball. */
interface Hand {
  orb: Orb;
  charge: Charge;
  /** performance.now() of their last throw, for the follow-through. */
  thrownAt: number;
}

/**
 * A fireball in flight, flown here along the server's arc from its launch;
 * for its first moments it is swung out of the hand it left, catapult-style.
 */
interface Flying {
  orb: Orb;
  trail: Trail;
  launch: FireballLaunch;
  /** performance.now() when it was thrown here: the click for your own, the cast's arrival for others'. */
  startedAt: number;
  /** World-space gap from the true position to the hand, swung away to nothing. */
  launchOffset: THREE.Vector3;
  /** Size of the ball in that hand, relative to flight size. */
  launchScale: number;
  /** Whether it left a hand we draw — if not, there is no swing, it just flies. */
  fromHand: boolean;
  /** Level, world-space direction of the throw: the swing pulls back against it. */
  forward: THREE.Vector3;
  lastFrame: number;
}

/** A point on the server's plane and height, in world space. */
function toWorldPoint(p: FireballPoint, out: THREE.Vector3) {
  toWorld(p.x, p.y, out);
  out.y = p.z * WORLD_SCALE;
  return out;
}

/** Where a ball thrown like this is after `age` seconds, in world space. */
function flightPosition(launch: FireballLaunch, age: number, out: THREE.Vector3) {
  return toWorldPoint(fireballPosition(launch, age), out);
}

/**
 * Outward normal of the surface a ball burst against, in world space: the
 * floor or one of the four walls (the server clamps the point onto it).
 */
function surfaceNormal(p: FireballPoint, out: THREE.Vector3) {
  const r = FIREBALL.radius + 0.01;
  if (p.z <= r) { return out.set(0, 1, 0); }
  if (p.x <= r) { return out.set(1, 0, 0); }
  if (p.x >= ARENA_WIDTH - r) { return out.set(-1, 0, 0); }
  if (p.y <= r) { return out.set(0, 0, 1); }
  return out.set(0, 0, -1);
}

/**
 * While Fireball is selected, local only: the catapult line from your hand
 * along the arc the ball will fly, and the blast ring where it will come down
 * if no one is in the way. Dim until the next ball is ready.
 */
class AimLine {
  private readonly group = new THREE.Group();
  private readonly material = new THREE.LineBasicMaterial({ color: 0xff8c2b, transparent: true, opacity: 0.8, depthWrite: false });
  private readonly line: THREE.Line;
  private readonly ringMaterial = glowMaterial(0xffd27a, 0.6);
  private readonly ring = new THREE.Mesh(new THREE.RingGeometry(BLAST_RADIUS * 0.9, BLAST_RADIUS, 48), this.ringMaterial);
  private readonly start = new THREE.Vector3();
  private readonly point = new THREE.Vector3();
  private readonly normal = new THREE.Vector3();

  constructor(parent: THREE.Object3D) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(LINE_POINTS * 3), 3));
    this.line = new THREE.Line(geometry, this.material);
    // Starts at the camera: never let it be culled for leaving its stale bounds.
    this.line.frustumCulled = false;
    this.group.add(this.line, this.ring);
    this.group.visible = false;
    parent.add(this.group);
  }

  /** `hand` is where the ball is held, in world space; the line eases from it onto the true arc like a thrown ball. */
  show(launch: FireballLaunch | null, hand: THREE.Vector3, ready: boolean) {
    this.group.visible = launch !== null;
    if (!launch) { return; }

    const landing = fireballLanding(launch);
    const offset = this.start.copy(hand).sub(flightPosition(launch, 0, this.point));
    const positions = this.line.geometry.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < LINE_POINTS; i++) {
      const age = (landing.t * i) / (LINE_POINTS - 1);
      flightPosition(launch, age, this.point).addScaledVector(offset, Math.max(0, 1 - age / SWING_S));
      positions.setXYZ(i, this.point.x, this.point.y, this.point.z);
    }
    // The last step may overshoot the surface: end exactly where it bursts.
    toWorldPoint(landing, this.point);
    positions.setXYZ(LINE_POINTS - 1, this.point.x, this.point.y, this.point.z);
    positions.needsUpdate = true;

    // Flat against the floor or wall it hits, a hair off the surface.
    surfaceNormal(landing, this.normal);
    this.ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), this.normal);
    this.ring.position.copy(this.point).addScaledVector(this.normal, 0.04 - RADIUS);

    this.material.opacity = ready ? 0.8 : 0.3;
    this.ringMaterial.opacity = ready ? 0.6 : 0.2;
  }

  dispose() {
    disposeGroup(this.group);
  }
}

/**
 * What everyone sees where a fireball blows up: a white flash, a fireball
 * filling the blast, a shockwave rolling across the floor beneath it and,
 * if it came down on the floor, a scorch mark that lingers.
 */
class BurstEffect implements Effect {
  private readonly group = new THREE.Group();
  private readonly flash = glowSprite(0xfff1b0);
  private readonly fire = glowSprite(0xff6a1a);
  private readonly smoulder = glowSprite(0xff3a10);
  private readonly shock = glowMaterial(0xffc06a);
  private readonly scorch = new THREE.MeshBasicMaterial({ color: 0x1a0904, transparent: true, opacity: 0, depthWrite: false });
  private readonly shockMesh: THREE.Mesh;
  private readonly onGround: boolean;
  private elapsed = 0;

  constructor(parent: THREE.Object3D, at: FireballPoint) {
    toWorldPoint(at, this.group.position);
    this.group.add(this.flash, this.fire, this.smoulder);

    // Floor marks sit on the floor, however high the blast.
    const floor = -this.group.position.y;
    this.shockMesh = onFloor(new THREE.Mesh(new THREE.RingGeometry(BLAST_RADIUS * 0.85, BLAST_RADIUS, 64), this.shock), floor + 0.05);
    this.group.add(this.shockMesh);
    this.onGround = at.z <= FIREBALL.radius + 1;
    if (this.onGround) {
      this.group.add(onFloor(new THREE.Mesh(new THREE.CircleGeometry(BLAST_RADIUS * 0.8, 48), this.scorch), floor + 0.015));
    }
    parent.add(this.group);
  }

  update(dt: number) {
    const t = (this.elapsed += dt);

    // Flash: pops past the blast in 0.08 s and is gone by 0.25 s.
    this.flash.scale.setScalar(BLAST_RADIUS * (0.8 + 2 * Math.min(t / 0.08, 1)));
    this.flash.material.opacity = Math.max(0, 1 - t / 0.25);

    // Fire: billows out to fill the blast and cools away by 0.7 s.
    const swell = Math.min(t / 0.7, 1);
    this.fire.scale.setScalar(BLAST_RADIUS * (1 + 1.6 * (1 - (1 - swell) ** 3)));
    this.fire.material.opacity = 0.95 * (1 - swell) ** 1.5;
    const glow = Math.min(t / 1, 1);
    this.smoulder.scale.setScalar(BLAST_RADIUS * (1.4 + 1.2 * glow));
    this.smoulder.material.opacity = 0.6 * (1 - glow) ** 2;

    // Shockwave: rolls out past the blast edge in 0.4 s.
    const wave = Math.min(t / 0.4, 1);
    this.shockMesh.scale.setScalar(0.3 + wave);
    this.shock.opacity = 0.9 * (1 - wave);

    // Scorch: lingers, then fades by 2.5 s.
    this.scorch.opacity = 0.6 * Math.min(t / 0.1, 1) * Math.max(0, 1 - Math.max(0, t - 1) / 1.5);

    return t < (this.onGround ? 2.5 : 1);
  }

  dispose() {
    disposeGroup(this.group);
  }
}

/** What the caster is aiming with, for the aim line: the view and where we see ourselves. */
export interface FireballAimView extends FireballAim {
  from: FireballPoint;
}

/**
 * Client side of Fireball, fire's main skill: the burning ball growing in your
 * own right hand (bottom right of the view) and in every other fire mage's,
 * the catapult line while it is selected, the throw, the balls in flight, the
 * blasts, and the cooldown display. A ball is full size exactly when the next
 * cast is allowed — that is the cooldown, shown in the world. The server
 * decides everything that matters (cooldown, path, hits). `slot` is null
 * when Fireball isn't in our kit: then there is no ball in our own hand, only
 * other fire mages' hands, balls and blasts.
 *
 * Positions in flight are never synced: each ball flies here from its launch,
 * and only its blast comes from the server. Someone else's ball starts when
 * their cast arrives; the blast arrives just as late, so it blows up about
 * where it is drawn. Your own leaves on the click, about one round trip ahead
 * of the server's — so at high latency it can fly on a little past what it hit
 * before the blast arrives and puts it out.
 */
export class FireballController {
  private readonly viewOrb: Orb;
  private readonly aimLine: AimLine;
  private readonly own = new Charge();
  private ownThrownAt = -Infinity;
  private readonly hands = new Map<string, Hand>();
  /** Balls in the air, by server id. */
  private readonly flying = new Map<number, Flying>();
  /**
   * Your own ball, thrown on the click and not yet confirmed. Casts wait for
   * their confirmation, so there is at most one; the next cast message for
   * us is its confirmation.
   */
  private pending: Flying | undefined;
  /** performance.now() when the next cast is allowed; Infinity while awaiting confirmation. */
  private readyAt = 0;
  private confirmTimer = 0;
  private awaiting = false;
  private readonly handAt = new THREE.Vector3();
  private readonly swingAt = new THREE.Vector3();

  constructor(
    private readonly room: ArenaRoom,
    private readonly scene: ArenaScene,
    private readonly effects: Effects,
    private readonly slot: AbilitySlotUi | null,
  ) {
    this.viewOrb = new Orb(scene.camera, VIEW_RADIUS);
    this.viewOrb.group.position.copy(VIEW_POSITION);
    this.aimLine = new AimLine(scene.scene);

    room.onMessage(SERVER_MESSAGE.fireballCast, (msg: FireballCast) => {
      const now = performance.now();
      if (msg.casterId !== room.sessionId) {
        const hand = this.hands.get(msg.casterId);
        if (hand) {
          hand.charge.restart(now, msg.cooldownMs);
          hand.thrownAt = now;
        }
        this.flying.set(msg.id, this.throw(msg, now, msg.casterId));
        return;
      }

      clearTimeout(this.confirmTimer);
      // Counting from arrival keeps us a little *behind* the server's own
      // cooldown, so a cast is never sent early and silently refused. The
      // ball keeps growing from the click, so it is full right on time.
      this.own.startedAt = this.awaiting ? this.own.startedAt : now;
      this.own.readyAt = now + msg.cooldownMs;
      this.readyAt = this.own.readyAt;
      this.awaiting = false;

      // Ours has been flying since the click: from now on it goes by the
      // server's id. Confirmed after we gave up on it: throw it now instead.
      this.flying.set(msg.id, this.pending ?? this.throw(msg, now, msg.casterId));
      this.pending = undefined;
    });

    // Put out at the server's blast point, wherever we were drawing it.
    room.onMessage(SERVER_MESSAGE.fireballHit, (msg: FireballHit) => {
      const flying = this.flying.get(msg.id);
      if (flying) { this.drop(flying); }
      this.flying.delete(msg.id);
      this.effects.add(new BurstEffect(scene.scene, msg));
    });
  }

  get ready() {
    return performance.now() >= this.readyAt;
  }

  /**
   * Click: throw along the view if the ball is fully grown; otherwise nothing.
   * `from` is our predicted position, where the server will launch it too.
   */
  cast(yaw: number, pitch: number, from: FireballPoint) {
    if (!this.slot || !this.ready) { return; }
    const aim: FireballAim = { yaw, pitch };
    this.room.send(CLIENT_MESSAGE.fireball, aim);

    // The ball leaves the hand right away, by the server's own launch rule;
    // a new one starts growing.
    const now = performance.now();
    this.pending = this.throw(launchFireball(from, aim), now, this.room.sessionId);
    this.own.restart(now, FIREBALL.cooldownMs);
    this.ownThrownAt = now;
    this.awaiting = true;
    // No double-sends while the server decides; give up waiting after a while.
    this.readyAt = Infinity;
    this.confirmTimer = window.setTimeout(() => {
      this.awaiting = false;
      this.readyAt = 0;
      this.own.restart(0, 0);
      if (this.pending) { this.drop(this.pending); }
      this.pending = undefined;
    }, CONFIRM_TIMEOUT_MS);
  }

  /** A remote fire mage: their next fireball grows beside their right hand. */
  addHand(sessionId: string, avatar: Avatar) {
    this.hands.set(sessionId, { orb: new Orb(avatar.hand, HAND_RADIUS), charge: new Charge(), thrownAt: -Infinity });
  }

  /** Hides a hand's ball while that player breathes fire from the same hand. */
  setHandBusy(sessionId: string, busy: boolean) {
    const hand = this.hands.get(sessionId);
    if (hand) { hand.orb.group.visible = !busy; }
  }

  /** The avatar is going away. */
  removeHand(sessionId: string) {
    this.hands.get(sessionId)?.orb.dispose();
    this.hands.delete(sessionId);
  }

  /** Where `casterId` holds their ball at rest, in world space; false if we don't draw one. */
  private handPosition(casterId: string, out: THREE.Vector3) {
    if (casterId === this.room.sessionId) {
      this.scene.camera.updateMatrixWorld();
      this.scene.camera.localToWorld(out.copy(VIEW_POSITION));
      return true;
    }
    const anchor = this.hands.get(casterId)?.orb.group.parent;
    anchor?.getWorldPosition(out);
    return anchor != null;
  }

  /** A ball leaving `casterId`'s hand at `startedAt`, swung out of the orb they were holding. */
  private throw(launch: FireballLaunch, startedAt: number, casterId: string): Flying {
    const orb = new Orb(this.scene.scene, RADIUS);
    // Wherever that orb is drawn — your own is held just ahead of your eyes,
    // so it must start small too.
    const own = casterId === this.room.sessionId;
    const launchOffset = new THREE.Vector3();
    const hand = this.handPosition(casterId, launchOffset);
    if (hand) { launchOffset.sub(flightPosition(launch, 0, orb.group.position)); }
    const launchScale = !hand ? 1 : (own ? VIEW_RADIUS : HAND_RADIUS) / RADIUS;
    // Thrown straight up or down: no level direction, so pull back toward the view's back.
    const forward = new THREE.Vector3(launch.vx, 0, launch.vy);
    if (forward.lengthSq() < 1e-6) { forward.set(0, 0, -1); }
    forward.normalize();
    return { orb, trail: new Trail(this.scene.scene), launch: { ...launch }, startedAt, launchOffset, launchScale, fromHand: hand, forward, lastFrame: startedAt };
  }

  /**
   * Moves a ball to where it is now; false once it has burnt out. For the
   * first `SWING_S` it is still on the catapult's arm: pulled back, whipped up
   * over the top, and let go onto its true arc.
   */
  private fly(flying: Flying, now: number) {
    const { orb, launch, launchOffset, launchScale, fromHand, forward } = flying;
    const age = (now - flying.startedAt) / 1000;
    if (age * 1000 >= FIREBALL.lifetimeMs) { return false; }
    const dt = Math.max(0, (now - flying.lastFrame) / 1000);
    flying.lastFrame = now;

    const position = flightPosition(launch, age, orb.group.position);
    const u = Math.min(age / SWING_S, 1);
    if (u < 1 && fromHand) {
      const held = 0.5 + 0.5 * Math.cos(Math.PI * u);
      const pull = u < 0.5 ? Math.sin(Math.PI * u * 2) : 0;
      position.addScaledVector(launchOffset, held)
        .addScaledVector(forward, -SWING_PULL * pull)
        .addScaledVector(WORLD_UP, SWING_LIFT * Math.sin(Math.PI * u));
    }
    orb.update(now / 1000, launchScale + (1 - launchScale) * u);
    flying.trail.update(dt, position);
    return true;
  }

  private drop(flying: Flying) {
    flying.orb.dispose();
    flying.trail.dispose();
  }

  /**
   * Per frame, after the camera moves: hands, the aim line, balls in flight
   * and the slot display. `selected` is whether Fireball is the active skill;
   * `alive` hides your own hand, and so does `busy` (breathing fire from it).
   * `aim` is the view to draw the aim line for, or null while not playing.
   */
  update(selected: boolean, alive: boolean, busy: boolean, aim: FireballAimView | null) {
    const now = performance.now();

    // The hand follows through after a throw: down and forward, then back.
    const own = followThrough(this.ownThrownAt, now);
    this.viewOrb.group.position.copy(VIEW_POSITION).add(this.swingAt.set(0, -0.12 * own, -0.06 * own));
    this.viewOrb.group.visible = this.slot !== null && alive && !busy;
    showCharge(this.viewOrb, this.own, now);
    for (const { orb, charge, thrownAt } of this.hands.values()) {
      const swing = followThrough(thrownAt, now);
      orb.group.position.set(0, -0.3 * swing, -0.25 * swing);
      showCharge(orb, charge, now);
    }

    const aiming = this.slot !== null && aim !== null && selected && alive && !busy;
    this.handPosition(this.room.sessionId, this.handAt);
    this.aimLine.show(aiming ? launchFireball(aim.from, aim) : null, this.handAt, this.ready);

    // Burnt out without touching anything: the server sends nothing for that.
    for (const [id, flying] of this.flying) {
      if (!this.fly(flying, now)) {
        this.drop(flying);
        this.flying.delete(id);
      }
    }
    if (this.pending && !this.fly(this.pending, now)) {
      this.drop(this.pending);
      this.pending = undefined;
    }

    this.showSlot(selected, now);
  }

  private showSlot(selected: boolean, now: number) {
    if (!this.slot) { return; }
    this.slot.root.classList.toggle("armed", selected);
    const remaining = this.awaiting ? FIREBALL.cooldownMs : Math.max(0, this.own.readyAt - now);
    this.slot.root.classList.toggle("cooling", remaining > 0);
    this.slot.root.style.setProperty("--cooldown", String(Math.min(1, remaining / FIREBALL.cooldownMs)));
    this.slot.cooldownText.textContent = remaining > 0 ? (remaining / 1000).toFixed(1) : "";
  }

  /**
   * A fresh round (`arenaReset`): every ball fully grown, none in the air —
   * the server dropped them all.
   */
  reset() {
    clearTimeout(this.confirmTimer);
    this.flying.forEach((flying) => this.drop(flying));
    this.flying.clear();
    if (this.pending) { this.drop(this.pending); }
    this.pending = undefined;
    this.awaiting = false;
    this.readyAt = 0;
    this.own.restart(0, 0);
    this.hands.forEach((hand) => hand.charge.restart(0, 0));
  }

  dispose() {
    clearTimeout(this.confirmTimer);
    this.viewOrb.dispose();
    this.aimLine.dispose();
    this.flying.forEach((flying) => this.drop(flying));
    this.flying.clear();
    if (this.pending) { this.drop(this.pending); }
    this.pending = undefined;
    this.hands.forEach(({ orb }) => orb.dispose());
    this.hands.clear();
    this.awaiting = false;
    this.own.restart(0, 0);
    this.showSlot(false, 0);
  }
}

/** A fireball grown and ready in the hand, pulsing: the lobby's fire mage. */
export function createFireballShowpiece(holder: ShowpieceHolder): Showpiece {
  const orb = new Orb(holder.hand, HAND_RADIUS);
  return {
    update: (now) => orb.update(now / 1000, chargeScale(1, now / 1000)),
    dispose: () => orb.dispose(),
  };
}
