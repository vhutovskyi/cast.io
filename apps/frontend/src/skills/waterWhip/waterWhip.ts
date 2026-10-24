import * as THREE from "three";
import {
  WATER_WHIP, nextWhipStep, whipCooldownMs, whipStrike,
  type WaterWhipAim, type WaterWhipCast, type WaterWhipPoint, type WhipComboState, type WhipHand, type WhipStep,
} from "@ligma/backend/skills/waterWhip/waterWhipConfig";
import { launchWhipShard } from "@ligma/backend/skills/waterWhip/whipShardConfig";
import { EYE_HEIGHT } from "@ligma/backend/shared/constants";
import { isUntargetable } from "@ligma/backend/effects/effectConfig";
import type { Player } from "@ligma/backend/rooms/schema/MyRoomState";
import { CLIENT_MESSAGE, SERVER_MESSAGE } from "@ligma/backend/shared/messages";
import { type ArenaScene, type Avatar, toWorld, WORLD_SCALE } from "../../render/scene";
import type { Showpiece, ShowpieceHolder } from "../showpiece";
import { type Effect, Effects, glowSprite, disposeGroup } from "../../render/effects";
import type { ArenaRoom } from "../../net/arenaRoom";
import type { AbilitySlotUi } from "../../hud/hud";
import { WhipShards } from "./whipShard";

/** First person: the right hand bottom right of the view, where the other elements' hands are too, the left mirrored (camera space). */
const VIEW_POSITION = new THREE.Vector3(0.36, -0.28, -0.8);
const VIEW_LEFT_POSITION = new THREE.Vector3(-VIEW_POSITION.x, VIEW_POSITION.y, VIEW_POSITION.z);
/** If the server doesn't confirm a lash this fast, treat it as refused. */
const CONFIRM_TIMEOUT_MS = 1500;

/** The ring of water flowing round the hand: radius in first person (camera space) and on others' avatars (world). */
const VIEW_RING_RADIUS = 0.06;
const HAND_RING_RADIUS = 0.3;
/** Drops flowing round the ring, and how fast they go round (turns per second). */
const RING_DROPS = 22;
const RING_SPIN = 1.4;

/**
 * The crack, in seconds. The handle swings from wound back to forward over
 * SWING_S; each point along the lash follows that swing a little later than
 * the one before — the tip TIP_LAG_S after the hand — so a loop rolls out
 * along it and the tip cracks last, at CRACK_S. Then it is drawn back in.
 */
const SWING_S = 0.12;
const TIP_LAG_S = 0.1;
const CRACK_S = SWING_S + TIP_LAG_S;
const HOLD_S = 0.05;
const BACK_S = 0.14;
/** Where the handle starts: wound back over the shoulder (radians off the strike line). */
const WOUND = 2.7;
/** How far past the line the tip flicks after the swing — the hook at the end — and how long that takes. */
const FLICK = 0.6;
const FLICK_S = 0.12;
/** The lash's length while still coiled at the hand, in world units. */
const COILED = 0.5;

/** Points along the lash, and sides round it. */
const POINTS = 40;
const SIDES = 8;
/**
 * Radius at the hand, in world units: others' lashes, and your own — thinner,
 * since it leaves from just ahead of your eyes. It tapers to TIP_RATIO of that.
 */
const THICK_HAND = 0.09;
const THICK_OWN = 0.03;
const TIP_RATIO = 0.2;
/** Foam flowing along the lash, hand to tip. */
const FOAM_BITS = 10;
const FOAM_FLOW = 3;

/** Spray thrown off a body the lash struck: how many drops, how long they last, how fast they fly. */
const DROPS = 12;
const SPLASH_S = 0.45;
const SPLASH_SPEED = 3;
const SPLASH_GRAVITY = 9;

const WORLD_UP = new THREE.Vector3(0, 1, 0);

/** A point on the server's plane and height, in world space. */
function toWorldPoint(p: WaterWhipPoint, out: THREE.Vector3) {
  toWorld(p.x, p.y, out);
  out.y = p.z * WORLD_SCALE;
  return out;
}

const clamp01 = (k: number) => Math.min(1, Math.max(0, k));
/** 0..1 eased out: fast at first, settling at the end. */
const easeOut = (k: number) => 1 - (1 - k) ** 3;
/** 0..1 eased in and out. */
const smooth = (k: number) => k * k * (3 - 2 * k);

/**
 * The angle off the strike line of the point `along` (0 at the hand, 1 at
 * the tip) `t` seconds into the crack. It follows the handle's swing — wound
 * back, swung through — late by how far out it is; after the swing the rope
 * flicks past the line and back, the tip most of all: the hook at the end.
 */
function lashAngle(t: number, along: number) {
  const late = t - TIP_LAG_S * along;
  if (late < SWING_S) { return WOUND * (1 - smooth(clamp01(late / SWING_S))); }
  return -FLICK * along * along * Math.sin(Math.PI * clamp01((late - SWING_S) / FLICK_S));
}

/**
 * Water flowing round in a ring: the water held in a water mage's hand. It
 * fills as the next lash gets ready and empties when one is cracked.
 */
class WaterRing {
  readonly group = new THREE.Group();
  private readonly drops = Array.from({ length: RING_DROPS }, (_, i) => {
    const sprite = glowSprite(i % 3 === 0 ? 0xd8f4ff : 0x5fb6ff);
    this.group.add(sprite);
    return { sprite, offset: i / RING_DROPS, wobble: Math.random() * Math.PI * 2 };
  });
  private readonly band: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>;
  private readonly phase = Math.random() * 10;

  constructor(parent: THREE.Object3D, private readonly radius: number) {
    this.band = new THREE.Mesh(
      new THREE.TorusGeometry(radius, radius * 0.18, 8, 32),
      new THREE.MeshBasicMaterial({ color: 0x3b8cff, transparent: true, opacity: 0, depthWrite: false }),
    );
    this.group.add(this.band);
    // Tipped toward the viewer, so it reads as a ring rather than a line.
    this.group.rotation.set(-1.1, 0, 0.3);
    parent.add(this.group);
  }

  /** `fill` (0..1) is how much water is back in the ring. */
  update(time: number, fill: number) {
    const t = time + this.phase;
    const r = this.radius;
    this.band.material.opacity = 0.35 * fill;
    this.band.scale.setScalar(0.6 + 0.4 * fill);
    for (const drop of this.drops) {
      // Round and round, bobbing in and out of the ring; only the part that's refilled flows.
      const angle = (drop.offset + t * RING_SPIN) * Math.PI * 2;
      const bob = 1 + 0.12 * Math.sin(t * 9 + drop.wobble);
      drop.sprite.position.set(Math.cos(angle) * r * bob, Math.sin(angle) * r * bob, 0.15 * r * Math.sin(t * 7 + drop.wobble));
      drop.sprite.scale.setScalar(r * (0.45 + 0.15 * Math.sin(t * 11 + drop.wobble)));
      drop.sprite.material.opacity = drop.offset < fill ? 0.85 : 0;
    }
  }

  dispose() {
    disposeGroup(this.group);
  }
}

/**
 * One crack of the whip, for everyone: a tapering rope of water rolling out
 * of the caster's hand, growing to full reach and cracking at `end` with a
 * flick of the tip, then drawn back in. Each point along it follows the
 * handle's swing a little later than the one before, which is what makes it
 * move like a whip. `hand` is asked every frame, so it stays in the hand of a
 * caster who turns or moves; it swings over that hand's shoulder. `onCrack`
 * runs when the tip cracks.
 */
class LashEffect implements Effect {
  private readonly group = new THREE.Group();
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material = new THREE.MeshBasicMaterial({ color: 0x4aa8ff, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide });
  private readonly foam = Array.from({ length: FOAM_BITS }, () => {
    const sprite = glowSprite(0xd8f4ff);
    this.group.add(sprite);
    return sprite;
  });
  private readonly tipGlow = glowSprite(0xbfe6ff);
  private readonly points = Array.from({ length: POINTS }, () => new THREE.Vector3());
  private readonly start = new THREE.Vector3();
  private readonly end = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly bend = new THREE.Vector3();
  private readonly across = new THREE.Vector3();
  private readonly tangent = new THREE.Vector3();
  private readonly normal = new THREE.Vector3();
  private readonly step = new THREE.Vector3();
  /** Which side it swings round from: a little to its hand's side of overhead. */
  private readonly lean: number;
  private elapsed = 0;
  private cracked = false;

  constructor(
    parent: THREE.Object3D,
    private readonly hand: (out: THREE.Vector3) => boolean,
    end: WaterWhipPoint,
    private readonly onCrack: () => void,
    private readonly thick: number,
    side: "right" | "left",
  ) {
    this.lean = (side === "right" ? 1 : -1) * (0.25 + 0.2 * Math.random());
    toWorldPoint(end, this.end);
    hand(this.start);

    this.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(POINTS * SIDES * 3), 3));
    const index: number[] = [];
    for (let i = 0; i < POINTS - 1; i++) {
      for (let j = 0; j < SIDES; j++) {
        const a = i * SIDES + j;
        const b = i * SIDES + ((j + 1) % SIDES);
        index.push(a, b, a + SIDES, b, b + SIDES, a + SIDES);
      }
    }
    this.geometry.setIndex(index);
    const rope = new THREE.Mesh(this.geometry, this.material);
    // Rebuilt every frame around the hand: never culled for stale bounds.
    rope.frustumCulled = false;
    this.group.add(rope, this.tipGlow);
    parent.add(this.group);
  }

  update(dt: number) {
    const t = (this.elapsed += dt);
    if (t >= CRACK_S + HOLD_S + BACK_S) { return false; }
    if (!this.cracked && t >= CRACK_S) {
      this.cracked = true;
      this.onCrack();
    }

    this.hand(this.start);
    this.frame();
    const full = this.start.distanceTo(this.end);
    // Grows out of the coil to full reach as it cracks, then is pulled back in.
    const length = t < CRACK_S
      ? COILED + (full - COILED) * easeOut(t / CRACK_S)
      : full - (full - COILED) * smooth(clamp01((t - CRACK_S - HOLD_S) / BACK_S));
    this.material.opacity = 0.85 * (1 - 0.6 * clamp01((t - CRACK_S - HOLD_S) / BACK_S));

    // Walk out from the hand: each point heads where the handle pointed a little earlier.
    const segment = length / (POINTS - 1);
    this.points[0].copy(this.start);
    for (let i = 1; i < POINTS; i++) {
      const along = i / (POINTS - 1);
      const angle = lashAngle(t, along);
      this.step.copy(this.forward).multiplyScalar(Math.cos(angle)).addScaledVector(this.bend, Math.sin(angle));
      this.points[i].copy(this.points[i - 1]).addScaledVector(this.step, segment);
    }

    this.buildRope();

    // Foam flowing down the lash toward the tip.
    this.foam.forEach((bit, k) => {
      const along = (k / FOAM_BITS + t * FOAM_FLOW) % 1;
      const at = along * (POINTS - 1);
      const i = Math.min(POINTS - 2, Math.floor(at));
      bit.position.lerpVectors(this.points[i], this.points[i + 1], at - i);
      bit.scale.setScalar(2.2 * this.thickness(along));
      bit.material.opacity = 0.7 * this.material.opacity;
    });
    // The tip flares as it cracks.
    const crack = Math.max(0, 1 - Math.abs(t - CRACK_S) / 0.06);
    this.tipGlow.position.copy(this.points[POINTS - 1]);
    this.tipGlow.scale.setScalar(0.15 + 0.5 * crack);
    this.tipGlow.material.opacity = 0.3 + 0.6 * crack;
    return true;
  }

  /** The strike line from the hand, and the direction it bends back in: up over the shoulder, leaning a little aside. */
  private frame() {
    this.forward.subVectors(this.end, this.start);
    if (this.forward.lengthSq() < 1e-8) { this.forward.set(0, 0, -1); }
    this.forward.normalize();
    this.across.crossVectors(this.forward, WORLD_UP);
    if (this.across.lengthSq() < 1e-6) { this.across.set(1, 0, 0); }
    this.across.normalize();
    this.bend.crossVectors(this.across, this.forward).normalize()
      .multiplyScalar(Math.cos(this.lean)).addScaledVector(this.across, Math.sin(this.lean)).normalize();
    // Round the rope: the plane it swings in has this as its normal.
    this.across.crossVectors(this.forward, this.bend).normalize();
  }

  private thickness(along: number) {
    return this.thick * (1 - (1 - TIP_RATIO) * along ** 0.7);
  }

  /** A tube round the points, thick at the hand and thin at the tip. */
  private buildRope() {
    const positions = this.geometry.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < POINTS; i++) {
      const prev = this.points[Math.max(0, i - 1)];
      const next = this.points[Math.min(POINTS - 1, i + 1)];
      this.tangent.subVectors(next, prev).normalize();
      this.normal.crossVectors(this.tangent, this.across).normalize();
      const radius = this.thickness(i / (POINTS - 1));
      for (let j = 0; j < SIDES; j++) {
        const phi = (j / SIDES) * Math.PI * 2;
        const c = Math.cos(phi) * radius;
        const s = Math.sin(phi) * radius;
        const p = this.points[i];
        positions.setXYZ(
          i * SIDES + j,
          p.x + this.across.x * c + this.normal.x * s,
          p.y + this.across.y * c + this.normal.y * s,
          p.z + this.across.z * c + this.normal.z * s,
        );
      }
    }
    positions.needsUpdate = true;
  }

  dispose() {
    disposeGroup(this.group);
  }
}

/** Water thrown off a body the lash struck: drops bursting out and falling. */
class SplashEffect implements Effect {
  private readonly group = new THREE.Group();
  private readonly drops = Array.from({ length: DROPS }, () => {
    const sprite = glowSprite(0x8fd3ff, 0.9);
    const angle = Math.random() * Math.PI * 2;
    const out = SPLASH_SPEED * (0.5 + Math.random());
    const velocity = new THREE.Vector3(Math.cos(angle) * out, SPLASH_SPEED * (0.4 + Math.random()), Math.sin(angle) * out);
    this.group.add(sprite);
    return { sprite, velocity };
  });
  private readonly flash = glowSprite(0xd8f4ff, 0.9);
  private elapsed = 0;

  constructor(parent: THREE.Object3D, at: WaterWhipPoint) {
    toWorldPoint(at, this.group.position);
    this.group.add(this.flash);
    parent.add(this.group);
  }

  update(dt: number) {
    const t = (this.elapsed += dt);
    const k = Math.min(t / SPLASH_S, 1);
    this.flash.scale.setScalar(0.4 + 1.2 * Math.min(t / 0.08, 1));
    this.flash.material.opacity = 0.9 * Math.max(0, 1 - t / 0.15);
    for (const { sprite, velocity } of this.drops) {
      velocity.y -= SPLASH_GRAVITY * dt;
      sprite.position.addScaledVector(velocity, dt);
      sprite.scale.setScalar(0.18 * (1 - 0.5 * k));
      sprite.material.opacity = 0.9 * (1 - k);
    }
    return k < 1;
  }

  dispose() {
    disposeGroup(this.group);
  }
}

/** A water mage's hand: the ring of water in it, and when it was last emptied by a lash. */
interface Hand {
  ring: WaterRing;
  /** performance.now() of the lash, and how long until the ring is full again. */
  castAt: number;
  refillMs: number;
}

/** Both of a water mage's hands; on others' avatars the left one hangs from a mount mirroring `Avatar.hand`. */
interface Hands {
  right: Hand;
  left: Hand;
  leftMount?: THREE.Object3D;
}

/** How full a hand's ring is at `now`: empty on the lash, full again when the next one is ready. */
function fill(hand: Hand, now: number) {
  return hand.refillMs > 0 ? clamp01((now - hand.castAt) / hand.refillMs) : 1;
}

/** The hand (or both, for the shard: the water of both hands makes it) a hit empties. */
function handsUsed(hands: Hands, hand: WhipHand): Hand[] {
  return hand === "center" ? [hands.right, hands.left] : [hands[hand]];
}

/** Everyone a lash may land on, as the server counts them: not the untargetable (under the ground). */
function* targets(players: Iterable<[string, Player]>): Iterable<[string, Player]> {
  for (const entry of players) {
    if (!isUntargetable(entry[1].effects)) { yield entry; }
  }
}

/**
 * Client side of Water Whip, water's main skill: water flowing round in a
 * ring in each of your hands (bottom left and right of the view) and in
 * every other water mage's, the three-hit combo everyone sees — a lash from
 * the right hand, one from the left, then a shard of ice thrown from between
 * the eyes (`WhipShards`) — the splash where a lash strikes, and the
 * cooldown display. A hand's ring empties into its lash (both into the
 * shard) and fills back up over the cooldown. Your own hit goes on the
 * click — whichever the shared combo rule says is due, toward whoever the
 * shared hit rule picks from here; which hit it was and whether it struck is
 * the server's word, which decides everything that matters (cooldown,
 * combo, who is struck). `slot` is null when Water Whip isn't in our kit:
 * then only other water mages' rings, lashes and shards are drawn.
 */
export class WaterWhipController {
  private readonly own: Hands;
  private readonly hands = new Map<string, Hands>();
  private readonly shards: WhipShards;
  /** performance.now() when the next hit is allowed; Infinity while awaiting confirmation. */
  private readyAt = 0;
  private cooldownEndsAt = 0;
  /** The current cooldown's whole length: longer after the shard. What the slot counts down from. */
  private cooldownMs: number = WATER_WHIP.cooldownMs;
  private confirmTimer = 0;
  /** Our last confirmed hit, timed from its click: what the combo rule counts from. */
  private combo: WhipComboState | undefined;
  /** performance.now() of our latest click. */
  private clickAt = 0;
  /**
   * Our own hit, drawn on the click and not yet confirmed: which step we
   * guessed, and — for a lash — whether it struck, which the server's echo
   * says. Hits wait for their confirmation, so there is at most one.
   */
  private pending: { step: WhipStep; strike?: Strike } | undefined;

  constructor(
    private readonly room: ArenaRoom,
    private readonly scene: ArenaScene,
    private readonly effects: Effects,
    private readonly slot: AbilitySlotUi | null,
  ) {
    const ring = (at: THREE.Vector3) => {
      const ring = new WaterRing(scene.camera, VIEW_RING_RADIUS);
      ring.group.position.copy(at);
      ring.group.visible = false;
      return { ring, castAt: 0, refillMs: 0 };
    };
    this.own = { right: ring(VIEW_POSITION), left: ring(VIEW_LEFT_POSITION) };
    this.shards = new WhipShards(room, scene, effects);

    room.onMessage(SERVER_MESSAGE.waterWhipCast, (msg: WaterWhipCast) => {
      const now = performance.now();
      if (msg.casterId !== room.sessionId) {
        const hands = this.hands.get(msg.casterId);
        if (hands) { handsUsed(hands, msg.hand).forEach((hand) => Object.assign(hand, { castAt: now, refillMs: msg.cooldownMs })); }
        // The shard is drawn from its own message.
        if (msg.hand !== "center") { this.lash(msg.casterId, msg.hand, msg.end).struck(msg.hitId !== undefined); }
        return;
      }

      clearTimeout(this.confirmTimer);
      // Counting from arrival keeps us a little *behind* the server's own
      // cooldown, so a hit is never sent early and silently refused. The
      // rings keep filling from the click, so they are full right on time.
      this.cooldownEndsAt = now + msg.cooldownMs;
      this.cooldownMs = msg.cooldownMs;
      this.readyAt = this.cooldownEndsAt;
      this.combo = { step: msg.step, at: this.clickAt };
      const pending = this.pending;
      this.pending = undefined;
      if (pending && pending.step !== msg.step) {
        // We guessed another hit of the combo: take ours back, show the server's.
        this.own.right.refillMs = this.own.left.refillMs = 0;
        pending.strike?.struck(false);
        if (pending.step === 2) { this.shards.dropOwn(); }
      }
      handsUsed(this.own, msg.hand).forEach((hand) => Object.assign(hand, { castAt: this.clickAt, refillMs: this.cooldownEndsAt - this.clickAt }));
      if (msg.hand === "center") { return; } // our shard, or the server's, flies from `whipShardCast`
      // Confirmed after we gave up on it (or another hit than we drew): crack it now instead.
      const strike = pending?.step === msg.step ? pending.strike : undefined;
      (strike ?? this.lash(msg.casterId, msg.hand, msg.end)).struck(msg.hitId !== undefined);
    });
  }

  get ready() {
    return performance.now() >= this.readyAt;
  }

  /**
   * Click: the combo's next hit along the view if the whip is ready;
   * otherwise nothing. `from` is our predicted position, where we see ourselves.
   */
  cast(yaw: number, pitch: number, from: WaterWhipPoint) {
    if (!this.slot || !this.ready) { return; }
    const aim: WaterWhipAim = { yaw, pitch };
    this.room.send(CLIENT_MESSAGE.waterWhip, aim);

    // Drawn now, by the server's own rules against where we see everyone.
    const now = performance.now();
    this.clickAt = now;
    const step = nextWhipStep(this.combo, now);
    if (step === 2) {
      this.shards.throwOwn(launchWhipShard(from, aim));
      this.pending = { step };
    } else {
      const end = whipStrike(this.room.sessionId, from, aim, targets(this.room.state.players), this.room.state.walls.values()).end;
      this.pending = { step, strike: this.lash(this.room.sessionId, step === 0 ? "right" : "left", end) };
    }
    const cooldownMs = whipCooldownMs(step);
    handsUsed(this.own, step === 2 ? "center" : step === 0 ? "right" : "left")
      .forEach((hand) => Object.assign(hand, { castAt: now, refillMs: cooldownMs }));
    // No double-sends while the server decides; give up waiting after a while.
    this.readyAt = Infinity;
    this.cooldownEndsAt = now + cooldownMs;
    this.cooldownMs = cooldownMs;
    this.confirmTimer = window.setTimeout(() => {
      this.readyAt = 0;
      this.cooldownEndsAt = 0;
      this.own.right.refillMs = this.own.left.refillMs = 0;
      this.pending?.strike?.struck(false);
      if (this.pending?.step === 2) { this.shards.dropOwn(); }
      this.pending = undefined;
    }, CONFIRM_TIMEOUT_MS);
  }

  /** A remote water mage (or anything drawn with an avatar that cracks a whip): water flows round in both hands. */
  addHand(sessionId: string, avatar: Avatar) {
    // The right hand's place, mirrored across the body: forward is -z, so left is -x.
    const leftMount = new THREE.Group();
    leftMount.position.copy(avatar.hand.position).setX(-avatar.hand.position.x);
    avatar.group.add(leftMount);
    this.hands.set(sessionId, {
      right: { ring: new WaterRing(avatar.hand, HAND_RING_RADIUS), castAt: 0, refillMs: 0 },
      left: { ring: new WaterRing(leftMount, HAND_RING_RADIUS), castAt: 0, refillMs: 0 },
      leftMount,
    });
  }

  /** The avatar is going away. */
  removeHand(sessionId: string) {
    const hands = this.hands.get(sessionId);
    if (hands) { disposeHands(hands); }
    this.hands.delete(sessionId);
  }

  /** Where `casterId`'s lash leaves `hand` from, in world space: its ring, or their eyes if we draw no hands. */
  private handPosition(casterId: string, hand: "right" | "left", out: THREE.Vector3) {
    const hands = casterId === this.room.sessionId ? this.own : this.hands.get(casterId);
    if (hands) {
      hands[hand].ring.group.getWorldPosition(out);
      return true;
    }
    const player = this.room.state.players.get(casterId);
    if (!player) { return false; }
    toWorldPoint({ x: player.x, y: player.y, z: player.z + EYE_HEIGHT }, out);
    return true;
  }

  /** Cracks a lash from `casterId`'s `hand` to `end`; splashes there if it turns out to have struck. */
  private lash(casterId: string, hand: "right" | "left", end: WaterWhipPoint): Strike {
    const strike = new Strike(() => this.effects.add(new SplashEffect(this.scene.scene, end)));
    const thick = casterId === this.room.sessionId ? THICK_OWN : THICK_HAND;
    this.effects.add(new LashEffect(this.scene.scene, (out) => this.handPosition(casterId, hand, out), end, () => strike.crack(), thick, hand));
    return strike;
  }

  /**
   * Per frame, after the camera moves: the water in hand, shards in flight
   * and the slot display. `selected` is whether Water Whip is the active
   * skill; `alive` shows your own hands.
   */
  update(selected: boolean, alive: boolean) {
    const now = performance.now();
    const time = now / 1000;
    for (const hand of [this.own.right, this.own.left]) {
      hand.ring.group.visible = this.slot !== null && alive;
      hand.ring.update(time, fill(hand, now));
    }
    for (const { right, left } of this.hands.values()) {
      right.ring.update(time, fill(right, now));
      left.ring.update(time, fill(left, now));
    }
    this.shards.update(now);

    this.showSlot(selected, Math.max(0, this.cooldownEndsAt - now));
  }

  private showSlot(selected: boolean, remaining: number) {
    if (!this.slot) { return; }
    this.slot.root.classList.toggle("armed", selected);
    this.slot.root.classList.toggle("cooling", remaining > 0);
    this.slot.root.style.setProperty("--cooldown", String(Math.min(1, remaining / this.cooldownMs)));
    this.slot.cooldownText.textContent = remaining > 0 ? (remaining / 1000).toFixed(1) : "";
  }

  /**
   * A fresh round (`arenaReset`): every ring full, ready right away, the
   * combo from the start, no shards in the air. Lashes in the air go with
   * the room's `Effects`.
   */
  reset() {
    clearTimeout(this.confirmTimer);
    this.readyAt = 0;
    this.cooldownEndsAt = 0;
    this.pending = undefined;
    this.combo = undefined;
    this.own.right.refillMs = this.own.left.refillMs = 0;
    this.hands.forEach(({ right, left }) => { right.refillMs = left.refillMs = 0; });
    this.shards.reset();
  }

  dispose() {
    this.reset();
    disposeHands(this.own);
    this.hands.forEach(disposeHands);
    this.hands.clear();
    this.showSlot(false, 0);
  }
}

function disposeHands({ right, left, leftMount }: Hands) {
  right.ring.dispose();
  left.ring.dispose();
  leftMount?.removeFromParent();
}

/**
 * Whether one lash splashes, and when: on its crack, once we know it struck.
 * Others' lashes are known at once; our own, drawn on the click, only when
 * the server answers — if that's after the crack, it splashes right then.
 */
class Strike {
  private cracked = false;
  private hit: boolean | undefined;

  constructor(private readonly splash: () => void) {}

  crack() {
    this.cracked = true;
    if (this.hit) { this.splash(); }
  }

  struck(hit: boolean) {
    if (this.hit !== undefined) { return; }
    this.hit = hit;
    if (hit && this.cracked) { this.splash(); }
  }
}

/** Full rings of water flowing in both hands: the lobby's water mage. */
export function createWaterWhipShowpiece(holder: ShowpieceHolder): Showpiece {
  // Mirrored across the body, as `addHand` does.
  const leftMount = new THREE.Group();
  leftMount.position.copy(holder.hand.position).setX(-holder.hand.position.x);
  holder.group.add(leftMount);
  const rings = [new WaterRing(holder.hand, HAND_RING_RADIUS), new WaterRing(leftMount, HAND_RING_RADIUS)];
  return {
    update: (now) => rings.forEach((ring) => ring.update(now / 1000, 1)),
    dispose: () => {
      rings.forEach((ring) => ring.dispose());
      leftMount.removeFromParent();
    },
  };
}
