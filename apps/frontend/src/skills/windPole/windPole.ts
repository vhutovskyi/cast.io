import * as THREE from "three";
import {
  WIND_BLAST_LIFETIME_S, WIND_POLE, launchWindBlast, poleStrike, windBlastPosition,
  type WindBlastLaunch, type WindPoleAim, type WindPoleCast, type WindPoleHit, type WindPolePoint,
} from "@ligma/backend/skills/windPole/windPoleConfig";
import { ARENA_HEIGHT, ARENA_WIDTH, PLAYER_HALF } from "@ligma/backend/shared/constants";
import { CLIENT_MESSAGE, SERVER_MESSAGE } from "@ligma/backend/shared/messages";
import { hasSkill } from "@ligma/backend/shared/skills";
import type { Player } from "@ligma/backend/rooms/schema/MyRoomState";
import { type ArenaScene, type Avatar, toWorld, WORLD_SCALE } from "../../render/scene";
import type { Showpiece, ShowpieceHolder } from "../showpiece";
import { type Effect, Effects, disposeGroup } from "../../render/effects";
import type { ArenaRoom } from "../../net/arenaRoom";
import type { AbilitySlotUi } from "../../hud/hud";
import type { SlotSkill } from "../slotSkill";
import type { ArenaFrame, ArenaSkillController } from "../arenaFrame";

/** First person: between the two hands, low and a little right of the view's centre (camera space). */
const VIEW_POSITION = new THREE.Vector3(0.14, -0.4, -0.6);
/**
 * On others' avatars: in front of the chest rather than at the right hand
 * (`Avatar.hand`, which this is relative to) — the pole is held with both.
 */
const AVATAR_POSITION = new THREE.Vector3(-(PLAYER_HALF * WORLD_SCALE + 0.3), -0.1, -0.35);
/** The pole: length and radius in first person (camera space) and on others' avatars (world). */
const VIEW_LENGTH = 1.1;
const VIEW_RADIUS = 0.016;
const HAND_LENGTH = 2.4;
const HAND_RADIUS = 0.05;
/**
 * Where along the pole, from the foot (0..1), it turns in a swing: between
 * the two hands, which hold it like a quarterstaff — the back one near the
 * butt, the front one partway up.
 */
const GRIP = 0.3;
const BACK_HAND = 0.1;
const FRONT_HAND = 0.48;
/** If the server doesn't confirm a swing this fast, treat it as refused (and take back the gust thrown on the click). */
const CONFIRM_TIMEOUT_MS = 1500;
/** Your own gust leaves the pole's head you see and settles onto its true line over this long. */
const BLEND_S = 0.1;

/**
 * The swing, in seconds: a quick wind-up over the shoulder, the sweep down
 * and across — the blow lands at its end, IMPACT_S in — a beat held there,
 * then back to rest.
 */
const WINDUP_S = 0.05;
const STRIKE_S = 0.09;
const IMPACT_S = WINDUP_S + STRIKE_S;
const HOLD_S = 0.06;
const RECOVER_S = 0.22;
/**
 * The pole's tilt at each stage (radians round the hand): `x` tips the head
 * forward (negative) or back, `z` leans it across to the left (positive).
 * Held leaning a little forward and inward; wound back over the right
 * shoulder; struck through, forward and down across the body.
 */
const REST = { x: -0.45, z: 0.85 };
const WOUND = { x: 0.5, z: 0.2 };
const STRUCK = { x: -1.6, z: 1.25 };

/** Plain wood, darker where the hands have worn it. */
const WOOD = 0x8a5a3b;
const WOOD_GRIP = 0x6b432b;

/**
 * Wind is drawn as strokes, not glow: a crescent of thin arcs bowed forward
 * where the air pushes, and straight streaks trailing behind it. Blue-gray,
 * plain (not additive) blending: air, not magic.
 */
const WIND = 0x9fb4c3;
const WIND_SHADES = [0x9fb4c3, 0x8ea6b8, 0xb3c4cf];
/** Half the crescent's height, how far its tips sweep back, and its stroke thickness (world units). */
const ARC_HALF = 0.55;
const ARC_SWEEP = 0.32;
const STROKE = 0.016;
/** The crescent's arcs: each a little further back and shorter than the one before. */
const ARCS = [{ back: 0, scale: 1 }, { back: 0.1, scale: 0.86 }, { back: 0.2, scale: 0.7 }];
/** The streaks behind it: height off the line (in crescent halves), and length (world units). */
const STREAKS = [{ y: 0.55, length: 1.1 }, { y: 0.1, length: 0.7 }, { y: -0.3, length: 0.9 }];
/** How far off vertical the crescent may lean, either way — picked at random per gust. */
const MAX_LEAN = 0.6;
/** A gust fades out over the last part of its life, rather than vanishing. */
const FADE_FROM = 0.75;
/** Where a gust breaks, or the pole lands: the air scattering — how many strokes, for how long, how fast. */
const SCATTER_STROKES = 5;
const SCATTER_S = 0.35;
const SCATTER_SPEED = 2.2;
/** The pole's own blow: a smaller scatter than a gust's. */
const PUFF_SIZE = 0.6;

const UP = new THREE.Vector3(0, 1, 0);
const SIDE = new THREE.Vector3(1, 0, 0);

/** A point on the server's plane and height, in world space. */
function toWorldPoint(p: WindPolePoint, out: THREE.Vector3) {
  toWorld(p.x, p.y, out);
  out.y = p.z * WORLD_SCALE;
  return out;
}

/** A direction on the server's plane and height, in world space (unit length). */
function toWorldDirection(v: WindPolePoint, out: THREE.Vector3) {
  out.set(v.x, v.z, v.y);
  if (out.lengthSq() < 1e-9) { return out.set(0, 0, -1); }
  return out.normalize();
}

const clamp01 = (k: number) => Math.min(1, Math.max(0, k));
/** 0..1 eased out: fast at first, settling at the end. */
const easeOut = (k: number) => 1 - (1 - k) ** 3;
/** 0..1 eased in and out. */
const smooth = (k: number) => k * k * (3 - 2 * k);

/** The pole's tilt `t` seconds into a swing; at rest before and after it. */
function swingPose(t: number): { x: number; z: number } {
  const between = (a: { x: number; z: number }, b: { x: number; z: number }, k: number) => ({ x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k });
  if (t < 0) { return REST; }
  if (t < WINDUP_S) { return between(REST, WOUND, easeOut(t / WINDUP_S)); }
  if (t < IMPACT_S) { return between(WOUND, STRUCK, smooth((t - WINDUP_S) / STRIKE_S)); }
  if (t < IMPACT_S + HOLD_S) { return STRUCK; }
  return between(STRUCK, REST, smooth(clamp01((t - IMPACT_S - HOLD_S) / RECOVER_S)));
}

/** A thin stroke along a curve of points. */
function stroke(points: THREE.Vector3[], material: THREE.Material, radius = STROKE) {
  return new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 16, radius, 4), material);
}

/** A crescent arc in the y/z plane, bowed toward +z: its tips sweep back by `sweep`. */
function arcPoints(half: number, sweep: number, back = 0) {
  return Array.from({ length: 9 }, (_, i) => {
    const t = i / 4 - 1;
    return new THREE.Vector3(0, t * half, -back - sweep * t * t);
  });
}

function windMaterial(color: number, opacity: number) {
  return new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
}

/** Turns `object` so its +z points along `direction` (world space, unit length), with +y as near up as can be. */
function faceAlong(object: THREE.Object3D, direction: THREE.Vector3) {
  const up = Math.abs(direction.y) > 0.99 ? SIDE : UP;
  // A matrix that looks from `direction` back at the origin has its +z along `direction`.
  object.quaternion.setFromRotationMatrix(new THREE.Matrix4().lookAt(direction, new THREE.Vector3(), up));
}

/**
 * A wind mage's pole: a plain wooden shaft, moved as if held in both hands
 * like a quarterstaff, turning between them. The hands themselves aren't
 * drawn, only the worn wraps where they grip. `swing` starts the one
 * animation every swing plays, blow or gust.
 */
class Pole {
  readonly group = new THREE.Group();
  /** Turns between the hands: the swing. */
  private readonly pivot = new THREE.Group();
  /** At the head: where a gust leaves from. */
  private readonly head = new THREE.Object3D();
  /** performance.now() when the last swing started. */
  private swungAt = -Infinity;

  constructor(parent: THREE.Object3D, length: number, radius: number) {
    const foot = -length * GRIP;
    const top = length * (1 - GRIP);
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(radius * 0.85, radius * 1.1, length, 8).translate(0, (foot + top) / 2, 0),
      new THREE.MeshStandardMaterial({ color: WOOD, roughness: 0.9, metalness: 0, flatShading: true }),
    );
    // Worn darker under each hand.
    const worn = new THREE.MeshStandardMaterial({ color: WOOD_GRIP, roughness: 1, metalness: 0, flatShading: true });
    for (const at of [BACK_HAND, FRONT_HAND]) {
      const y = foot + length * at;
      this.pivot.add(new THREE.Mesh(new THREE.CylinderGeometry(radius * 1.12, radius * 1.12, length * 0.1, 8).translate(0, y, 0), worn));
    }
    this.head.position.y = top;
    this.pivot.add(shaft, this.head);
    this.pivot.rotation.set(REST.x, 0, REST.z);
    this.group.add(this.pivot);
    parent.add(this.group);
  }

  swing(now: number) {
    this.swungAt = now;
  }

  /** Ready to swing again at once: a fresh round. */
  rest() {
    this.swungAt = -Infinity;
  }

  /** Seconds into the current swing (Infinity if none). */
  sinceSwing(now: number) {
    return (now - this.swungAt) / 1000;
  }

  /** Where the head is, in world space. */
  headPosition(out: THREE.Vector3) {
    this.head.updateWorldMatrix(true, false);
    return this.head.getWorldPosition(out);
  }

  update(now: number) {
    const pose = swingPose(this.sinceSwing(now));
    this.pivot.rotation.set(pose.x, 0, pose.z);
  }

  dispose() {
    disposeGroup(this.group);
  }
}

/**
 * A gust of wind in flight: a crescent of arcs bowed along its line, leaning
 * a random way off vertical, with streaks trailing behind. `point` turns it
 * to fly along a direction.
 */
class Gust {
  readonly group = new THREE.Group();
  /** Leans the crescent round the line of flight. */
  private readonly lean = new THREE.Group();
  private readonly materials: THREE.MeshBasicMaterial[] = [];
  private readonly streaks: THREE.Mesh[] = [];
  private readonly phase = Math.random() * 10;

  constructor(parent: THREE.Object3D) {
    ARCS.forEach(({ back, scale }, i) => {
      const material = windMaterial(WIND_SHADES[i % WIND_SHADES.length], 0.85);
      this.materials.push(material);
      this.lean.add(stroke(arcPoints(ARC_HALF * scale, ARC_SWEEP * scale, back), material));
    });
    for (const { y, length } of STREAKS) {
      const material = windMaterial(WIND, 0.6);
      this.materials.push(material);
      // Starting just behind the crescent, built 1 long so it can stretch.
      const streak = stroke([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)], material, STROKE * 0.7);
      streak.position.set(0, y * ARC_HALF, -ARC_SWEEP * 0.6);
      streak.scale.z = length;
      this.lean.add(streak);
      this.streaks.push(streak);
    }
    this.lean.rotation.z = (Math.random() * 2 - 1) * MAX_LEAN;
    this.group.add(this.lean);
    parent.add(this.group);
  }

  /** Points the gust along `direction` (world space, unit length). */
  point(direction: THREE.Vector3) {
    faceAlong(this.group, direction);
  }

  /** `life` is how far through its flight it is, 0..1: the streaks waver, and it thins out at the end. */
  update(time: number, life: number) {
    STREAKS.forEach(({ length }, i) => {
      this.streaks[i].scale.z = length * (0.85 + 0.15 * Math.sin((time + this.phase) * 18 + i * 2));
    });
    const fade = life < FADE_FROM ? 1 : Math.max(0, 1 - (life - FADE_FROM) / (1 - FADE_FROM));
    this.materials.forEach((material, i) => material.opacity = (i < ARCS.length ? 0.85 : 0.6) * fade);
  }

  dispose() {
    disposeGroup(this.group);
  }
}

/**
 * Where a gust breaks, or the pole lands: the air scattering off what it hit
 * — a few short arcs blown out round `normal`, slowing and thinning away.
 * `size` scales it (smaller for the pole's own blow). Waits `delay` seconds
 * before showing, so a blow lands with the swing.
 */
class GustBurst implements Effect {
  private readonly group = new THREE.Group();
  private readonly strokes: { mesh: THREE.Mesh; material: THREE.MeshBasicMaterial; velocity: THREE.Vector3 }[] = [];
  private elapsed = 0;

  /** `normal` is which way it blows out: off the surface, or back toward whoever swung. */
  constructor(parent: THREE.Object3D, at: WindPolePoint, normal: THREE.Vector3, private readonly size = 1, private readonly delay = 0) {
    toWorldPoint(at, this.group.position);
    const side = new THREE.Vector3().crossVectors(normal, Math.abs(normal.y) > 0.9 ? SIDE : UP).normalize();
    const across = new THREE.Vector3().crossVectors(normal, side);
    for (let i = 0; i < SCATTER_STROKES; i++) {
      // Out round the normal in a wide fan, mostly sideways: air spreading off what it hit.
      const angle = (i / SCATTER_STROKES) * Math.PI * 2 + Math.random() * 0.6;
      const velocity = normal.clone().multiplyScalar(0.5 + 0.3 * Math.random())
        .addScaledVector(side, Math.cos(angle))
        .addScaledVector(across, Math.sin(angle))
        .normalize();
      const material = windMaterial(WIND_SHADES[i % WIND_SHADES.length], 0);
      const half = ARC_HALF * size * (0.35 + 0.2 * Math.random());
      const mesh = stroke(arcPoints(half, half * 0.6), material, STROKE * Math.max(size, 0.8));
      // Each arc bows the way it is blown.
      faceAlong(mesh, velocity);
      mesh.rotateZ(Math.random() * Math.PI);
      velocity.multiplyScalar(SCATTER_SPEED * size * (0.6 + 0.6 * Math.random()));
      this.group.add(mesh);
      this.strokes.push({ mesh, material, velocity });
    }
    this.group.visible = delay <= 0;
    parent.add(this.group);
  }

  update(dt: number) {
    this.elapsed += dt;
    const t = this.elapsed - this.delay;
    this.group.visible = t >= 0;
    if (t < 0) { return true; }
    const k = Math.min(t / SCATTER_S, 1);
    for (const { mesh, material, velocity } of this.strokes) {
      velocity.multiplyScalar(Math.max(0, 1 - 5 * dt));
      mesh.position.addScaledVector(velocity, dt);
      mesh.scale.setScalar(1 + 0.6 * easeOut(k));
      material.opacity = 0.8 * (1 - k) ** 1.5;
    }
    return k < 1;
  }

  dispose() {
    disposeGroup(this.group);
  }
}

/** A gust in flight, flown here along the server's line from its launch. */
interface Flying {
  gust: Gust;
  launch: WindBlastLaunch;
  /** performance.now() when it was thrown here: the click for your own, the cast's arrival for others'. */
  startedAt: number;
  /** World-space gap from the true position to the pole's head it left, closed over BLEND_S; zero if we draw no pole. */
  launchOffset: THREE.Vector3;
  /** Where it is flying, in world space: which way it blows back off a body. */
  direction: THREE.Vector3;
}

/**
 * Outward normal of the arena surface a gust broke against, in world space:
 * the floor or one of the four walls (the server clamps the point onto it) —
 * or null if it broke on something else, a raised wall or a body.
 */
function surfaceNormal(p: WindPolePoint, out: THREE.Vector3) {
  const r = WIND_POLE.radius + 0.01;
  if (p.z <= r) { return out.set(0, 1, 0); }
  if (p.x <= r) { return out.set(1, 0, 0); }
  if (p.x >= ARENA_WIDTH - r) { return out.set(-1, 0, 0); }
  if (p.y <= r) { return out.set(0, 0, 1); }
  if (p.y >= ARENA_HEIGHT - r) { return out.set(0, 0, -1); }
  return null;
}

/**
 * Client side of Wind Pole, wind's main skill: the pole in your own hands
 * (bottom right of the view) and in every other wind mage's, the swing
 * everyone sees — the same whether the pole lands or throws a gust — the
 * gusts in flight, the puff where a blow lands or a gust breaks, and the
 * cooldown display. The server decides everything that matters (cooldown,
 * blow or gust, who is struck). `slot` is null when Wind Pole isn't in our
 * kit: then only other wind mages' poles and swings are drawn.
 *
 * Gust positions are never synced: each flies here from its launch, and
 * only where it breaks comes from the server. Your own leaves on the click
 * when the shared melee rule finds no one in reach from here; should the
 * server see it the other way, its word wins.
 */
export class WindPoleController implements SlotSkill, ArenaSkillController {
  readonly selected = false;
  private readonly viewPole: Pole;
  /** Other wind mages' poles, by session id. */
  private readonly poles = new Map<string, Pole>();
  /** Gusts in the air, by server id. */
  private readonly flying = new Map<number, Flying>();
  /**
   * Your own gust, thrown on the click and not yet confirmed. Swings wait for
   * their confirmation, so there is at most one; the next cast message for us
   * is its confirmation.
   */
  private pending: Flying | undefined;
  /** performance.now() when the next swing is allowed; Infinity while awaiting confirmation. */
  private readyAt = 0;
  private cooldownEndsAt = 0;
  private confirmTimer = 0;
  private readonly normal = new THREE.Vector3();
  private readonly scratch = new THREE.Vector3();

  constructor(
    private readonly room: ArenaRoom,
    private readonly scene: ArenaScene,
    private readonly effects: Effects,
    private readonly slot: AbilitySlotUi | null,
  ) {
    this.viewPole = new Pole(scene.camera, VIEW_LENGTH, VIEW_RADIUS);
    this.viewPole.group.position.copy(VIEW_POSITION);
    this.viewPole.group.visible = false;

    room.onMessage(SERVER_MESSAGE.windPoleCast, (msg: WindPoleCast) => {
      const now = performance.now();
      const own = msg.casterId === room.sessionId;
      const pole = own ? this.viewPole : this.poles.get(msg.casterId);
      if (own) {
        clearTimeout(this.confirmTimer);
        // Counting from arrival keeps us a little *behind* the server's own
        // cooldown, so a swing is never sent early and silently refused.
        this.cooldownEndsAt = now + msg.cooldownMs;
        this.readyAt = this.cooldownEndsAt;
      } else {
        pole?.swing(now);
      }

      if (msg.kind === "blast") {
        // Ours has been flying since the click: from now on it goes by the
        // server's id. Confirmed after we gave up on it — or the pole was
        // thought to land from here — throw it now instead.
        const flying = (own && this.pending) || this.throw(msg, now, false);
        this.flying.set(msg.id, flying);
        if (own) { this.pending = undefined; }
        return;
      }

      // The pole landed: no gust after all, a puff on the body as the blow lands.
      if (own && this.pending) { this.drop(this.pending); }
      if (own) { this.pending = undefined; }
      // Blown back off the body, level, toward whoever swung.
      const caster = room.state.players.get(msg.casterId);
      this.normal.copy(UP);
      if (caster) {
        toWorldPoint({ x: caster.x, y: caster.y, z: msg.strike.z }, this.normal).sub(toWorldPoint(msg.strike, this.scratch));
        if (this.normal.lengthSq() < 1e-9) { this.normal.copy(UP); }
      }
      this.normal.normalize();
      const delay = pole ? Math.max(0, IMPACT_S - pole.sinceSwing(now)) : 0;
      this.effects.add(new GustBurst(scene.scene, msg.strike, this.normal, PUFF_SIZE, delay));
    });

    // Broke at the server's point, wherever we were drawing it.
    room.onMessage(SERVER_MESSAGE.windPoleHit, (msg: WindPoleHit) => {
      const flying = this.flying.get(msg.id);
      this.flying.delete(msg.id);
      const surface = msg.hitId === undefined ? surfaceNormal(msg, this.normal) : null;
      if (!surface) {
        // Off a body or a raised wall: back the way it came.
        if (flying) { this.normal.copy(flying.direction).negate(); } else { this.normal.copy(UP); }
      }
      if (flying) { this.drop(flying); }
      this.effects.add(new GustBurst(scene.scene, msg, this.normal));
    });
  }

  get ready() {
    return performance.now() >= this.readyAt;
  }

  /**
   * Click: swing the pole along the view if it's ready; otherwise nothing.
   * `from` is our predicted position, where we see ourselves. With no one in
   * reach from here, a gust leaves the pole's head right away, by the
   * server's own launch rule.
   */
  cast(yaw: number, pitch: number, from: WindPolePoint) {
    if (!this.slot || !this.ready) { return; }
    const aim: WindPoleAim = { yaw, pitch };
    this.room.send(CLIENT_MESSAGE.windPole, aim);

    const now = performance.now();
    this.viewPole.swing(now);
    const reached = poleStrike(this.room.sessionId, from, yaw, this.room.state.players, this.room.state.walls.values());
    if (!reached) { this.pending = this.throw(launchWindBlast(from, aim), now, true); }
    // No double-sends while the server decides; give up waiting after a while.
    this.readyAt = Infinity;
    this.cooldownEndsAt = now + WIND_POLE.cooldownMs;
    this.confirmTimer = window.setTimeout(() => {
      this.readyAt = 0;
      this.cooldownEndsAt = 0;
      if (this.pending) { this.drop(this.pending); }
      this.pending = undefined;
    }, CONFIRM_TIMEOUT_MS);
  }

  // The main skill: the arena calls `cast` on a click while nothing else is selected.
  toggle() {}
  cancel() {}
  press() {}
  release() {}

  /** A remote wind mage: a pole in their right hand. */
  addPlayer(sessionId: string, avatar: Avatar, player: Player) {
    if (!hasSkill(player.element, "wind_pole")) { return; }
    const pole = new Pole(avatar.hand, HAND_LENGTH, HAND_RADIUS);
    pole.group.position.copy(AVATAR_POSITION);
    this.poles.set(sessionId, pole);
  }

  /** The avatar is going away. */
  removePlayer(sessionId: string) {
    this.poles.get(sessionId)?.dispose();
    this.poles.delete(sessionId);
  }

  /** A gust leaving at `startedAt`: your own from the pole's head you see, anyone else's from their launch point. */
  private throw(launch: WindBlastLaunch, startedAt: number, own: boolean): Flying {
    const gust = new Gust(this.scene.scene);
    const launchOffset = new THREE.Vector3();
    if (own) { this.viewPole.headPosition(launchOffset).sub(toWorldPoint(windBlastPosition(launch, 0), gust.group.position)); }
    const direction = toWorldDirection({ x: launch.vx, y: launch.vy, z: launch.vz }, new THREE.Vector3());
    gust.point(direction);
    return { gust, launch: { ...launch }, startedAt, launchOffset, direction };
  }

  /** Moves a gust to where it is now; false once it has died out. */
  private fly(flying: Flying, now: number) {
    const { gust, launch, launchOffset } = flying;
    const age = (now - flying.startedAt) / 1000;
    if (age >= WIND_BLAST_LIFETIME_S) { return false; }
    toWorldPoint(windBlastPosition(launch, age), gust.group.position)
      .addScaledVector(launchOffset, Math.max(0, 1 - age / BLEND_S));
    gust.update(now / 1000, age / WIND_BLAST_LIFETIME_S);
    return true;
  }

  private drop(flying: Flying) {
    flying.gust.dispose();
  }

  /** Per frame, after the camera moves: the poles, gusts in flight, and the slot display. */
  update(frame: ArenaFrame) {
    const now = performance.now();
    this.viewPole.group.visible = this.slot !== null && frame.alive;
    this.viewPole.update(now);
    for (const pole of this.poles.values()) { pole.update(now); }

    // Died out in the air without touching anything: the server sends nothing for that.
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

    this.showSlot(frame.mainSelected, Math.max(0, this.cooldownEndsAt - now));
  }

  private showSlot(selected: boolean, remaining: number) {
    if (!this.slot) { return; }
    this.slot.root.classList.toggle("armed", selected);
    this.slot.root.classList.toggle("cooling", remaining > 0);
    this.slot.root.style.setProperty("--cooldown", String(Math.min(1, remaining / WIND_POLE.cooldownMs)));
    this.slot.cooldownText.textContent = remaining > 0 ? (remaining / 1000).toFixed(1) : "";
  }

  /**
   * A fresh round (`arenaReset`): ready right away, every pole at rest, no
   * gusts in the air — the server dropped them all. Puffs go with the room's `Effects`.
   */
  reset() {
    clearTimeout(this.confirmTimer);
    this.flying.forEach((flying) => this.drop(flying));
    this.flying.clear();
    if (this.pending) { this.drop(this.pending); }
    this.pending = undefined;
    this.readyAt = 0;
    this.cooldownEndsAt = 0;
    this.viewPole.rest();
    this.poles.forEach((pole) => pole.rest());
  }

  dispose() {
    this.reset();
    this.viewPole.dispose();
    this.poles.forEach((pole) => pole.dispose());
    this.poles.clear();
    this.showSlot(false, 0);
  }
}

/** The pole held at rest: the lobby's wind mage. */
export function createWindPoleShowpiece(holder: ShowpieceHolder): Showpiece {
  const pole = new Pole(holder.hand, HAND_LENGTH, HAND_RADIUS);
  pole.group.position.copy(AVATAR_POSITION);
  return {
    update: (now) => pole.update(now),
    dispose: () => pole.dispose(),
  };
}
