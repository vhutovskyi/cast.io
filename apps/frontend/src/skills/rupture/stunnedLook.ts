import * as THREE from "three";
import { PLAYER_HEIGHT } from "@ligma/backend/shared/constants";
import { type ArenaScene, type Avatar, WORLD_SCALE } from "../../render/scene";
import { glowSprite, disposeGroup } from "../../render/effects";

/** The effect this draws, by its server id. */
const STUNNED = "stunned";

/** The ring over a stunned head, in world units: how high above the body, and how wide. */
const RING_HEIGHT = PLAYER_HEIGHT * WORLD_SCALE + 0.3;
const RING_RADIUS = 0.38;
/** Pebbles and stars circling in it, how fast (radians per second) and how much the ring bobs and tilts. */
const PEBBLES = 4;
const STARS = 3;
const SPIN = 4;
const BOB = 0.05;
const TILT = 0.18;
/** It pops in over this, and fades away over the next, in seconds. */
const POP_S = 0.15;
const FADE_S = 0.25;

/** The daze over our own view: how far in front of the camera it hangs (inside the near plane's reach), and how fast it comes and goes. */
const VIGNETTE_DISTANCE = 0.1;
const VIGNETTE_IN_S = 0.12;
const VIGNETTE_OUT_S = 0.4;
const VIGNETTE_TEXTURE_SIZE = 512;
/** How far the view's dusty rim sways (radians) and how fast; oversized so the sway never shows its edges. */
const SWAY = 0.06;
const SWAY_SPEED = 2.2;
const OVERSIZE = 1.15;
/** Stars circling at the top of our own view, on an ellipse in view-plane units at its distance. */
const VIEW_STARS = 4;
const VIEW_STAR_SIZE = 0.009;
const VIEW_STAR_ORBIT = new THREE.Vector2(0.032, 0.008);
const VIEW_STAR_HEIGHT = 0.042;

/** What this reads off a synced `Player`. */
export interface StunnedLookPlayer {
  hp: number;
  effects: Iterable<string>;
}

function isStunned(player: StunnedLookPlayer) {
  if (player.hp <= 0) { return false; }
  for (const id of player.effects) {
    if (id === STUNNED) { return true; }
  }
  return false;
}

/**
 * Pebbles and stars circling over a remote player's head, hung on their
 * avatar so they go wherever it is drawn: a wobbling ring that pops in when
 * the stun lands and fades away once it is over.
 */
class StunMarker {
  readonly group = new THREE.Group();
  private readonly ring = new THREE.Group();
  private readonly rockMaterial = new THREE.MeshStandardMaterial({ color: 0x8f7a63, roughness: 0.9, flatShading: true });
  private readonly stars = Array.from({ length: STARS }, () => glowSprite(0xffe08a));
  private readonly dust = glowSprite(0xb08850);
  /** Seconds since it popped in; and since it began to fade, NaN while still stunned. */
  private age = 0;
  private fading = NaN;

  constructor(readonly avatar: Avatar) {
    const rock = new THREE.DodecahedronGeometry(0.075, 0);
    for (let i = 0; i < PEBBLES; i++) {
      const angle = (i / PEBBLES) * Math.PI * 2;
      const pebble = new THREE.Mesh(rock, this.rockMaterial);
      pebble.position.set(Math.cos(angle) * RING_RADIUS, 0, Math.sin(angle) * RING_RADIUS);
      pebble.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0);
      pebble.scale.setScalar(0.7 + 0.6 * Math.random());
      this.ring.add(pebble);
    }
    // Stars between the pebbles.
    this.stars.forEach((star, i) => {
      const angle = ((i + 0.5) / STARS) * Math.PI * 2;
      star.position.set(Math.cos(angle) * RING_RADIUS, 0.04, Math.sin(angle) * RING_RADIUS);
      this.ring.add(star);
    });
    this.dust.material.blending = THREE.NormalBlending;
    this.dust.scale.set(RING_RADIUS * 3, RING_RADIUS * 1.2, 1);
    this.group.add(this.ring, this.dust);
    this.group.position.y = RING_HEIGHT;
    avatar.group.add(this.group);
  }

  /** The stun is over: fade away. */
  fade() {
    if (Number.isNaN(this.fading)) { this.fading = 0; }
  }

  /** Stunned again before it faded away: back to full. */
  restun() {
    if (!Number.isNaN(this.fading)) { this.fading = NaN; }
  }

  /** False once it has faded away. */
  update(dt: number) {
    const t = (this.age += dt);
    const pop = Math.min(t / POP_S, 1);
    if (!Number.isNaN(this.fading)) { this.fading += dt; }
    const left = Number.isNaN(this.fading) ? 1 : Math.max(0, 1 - this.fading / FADE_S);
    // Overshoots a little as it pops in.
    const size = (pop < 1 ? pop * (1.25 - 0.25 * pop) : 1) * left;

    this.group.scale.setScalar(Math.max(1e-3, size));
    this.ring.rotation.set(Math.sin(t * 3.1) * TILT, t * SPIN, Math.cos(t * 2.3) * TILT);
    this.ring.position.y = Math.sin(t * 5) * BOB;
    this.stars.forEach((star, i) => {
      const twinkle = 0.6 + 0.4 * Math.sin(t * 9 + i * 2.1);
      star.material.opacity = twinkle * left;
      star.scale.setScalar(0.16 + 0.1 * twinkle);
    });
    this.dust.material.opacity = 0.25 * left;
    return left > 0;
  }

  dispose() {
    // Pebbles share one geometry and material: `disposeGroup` frees them (again, harmlessly) per pebble.
    disposeGroup(this.group);
  }
}

/**
 * A dusty, dimmed rim round a canvas: clear in the middle, darkening toward
 * the edges, with grit and specks of dust scattered through the rim.
 */
function createDazeTexture() {
  const size = VIGNETTE_TEXTURE_SIZE;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const half = size / 2;

  const rim = ctx.createRadialGradient(half, half, size * 0.22, half, half, size * 0.72);
  rim.addColorStop(0, "rgba(60, 45, 30, 0)");
  rim.addColorStop(0.5, "rgba(70, 52, 34, 0.35)");
  rim.addColorStop(1, "rgba(30, 22, 14, 0.9)");
  ctx.fillStyle = rim;
  ctx.fillRect(0, 0, size, size);

  // Grit: specks of dust, thicker toward the rim.
  for (let i = 0; i < 500; i++) {
    const around = Math.random() * Math.PI * 2;
    const out = half * (0.45 + 0.6 * Math.sqrt(Math.random()));
    const shade = 120 + Math.floor(Math.random() * 70);
    ctx.fillStyle = `rgba(${shade}, ${Math.floor(shade * 0.8)}, ${Math.floor(shade * 0.55)}, ${0.15 + 0.35 * Math.random()})`;
    ctx.beginPath();
    ctx.arc(half + Math.cos(around) * out, half + Math.sin(around) * out, 1 + Math.random() * 3, 0, Math.PI * 2);
    ctx.fill();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * The daze over our own view while we are stunned: a dusty, dimmed rim hung
 * just in front of the camera that sways and breathes, and stars circling at
 * the top of the view. Drawn over everything else.
 */
class DazeVignette {
  private readonly group = new THREE.Group();
  private readonly texture = createDazeTexture();
  private readonly material = new THREE.MeshBasicMaterial({
    map: this.texture, transparent: true, opacity: 0, depthTest: false, depthWrite: false,
  });
  private readonly mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.material);
  private readonly stars = Array.from({ length: VIEW_STARS }, () => {
    const star = glowSprite(0xffe08a);
    star.material.depthTest = false;
    star.renderOrder = 1000;
    star.scale.setScalar(VIEW_STAR_SIZE);
    this.group.add(star);
    return star;
  });
  private shown = 0;
  private time = 0;

  constructor(private readonly camera: THREE.PerspectiveCamera) {
    this.mesh.renderOrder = 999;
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);
    this.group.position.z = -VIGNETTE_DISTANCE;
    this.group.visible = false;
    camera.add(this.group);
  }

  update(dt: number, stunned: boolean) {
    this.time += dt;
    this.shown = stunned
      ? Math.min(1, this.shown + dt / VIGNETTE_IN_S)
      : Math.max(0, this.shown - dt / VIGNETTE_OUT_S);
    this.group.visible = this.shown > 0;
    if (!this.group.visible) { return; }
    const t = this.time;

    // Fills the view at its distance, oversized so the sway keeps its edges off screen.
    const height = 2 * VIGNETTE_DISTANCE * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) * OVERSIZE;
    const breathe = 1 + 0.03 * Math.sin(t * 3.1);
    this.mesh.scale.set(height * this.camera.aspect * breathe, height * breathe, 1);
    this.mesh.rotation.z = Math.sin(t * SWAY_SPEED) * SWAY;
    this.material.opacity = this.shown * (0.85 + 0.15 * Math.sin(t * 4.3));

    this.stars.forEach((star, i) => {
      const angle = t * SPIN + (i / VIEW_STARS) * Math.PI * 2;
      star.position.set(Math.cos(angle) * VIEW_STAR_ORBIT.x, VIEW_STAR_HEIGHT + Math.sin(angle) * VIEW_STAR_ORBIT.y, 0.001);
      // Dimmer as they pass behind, on the ellipse's far side.
      star.material.opacity = this.shown * (0.55 + 0.45 * Math.sin(angle));
    });
  }

  dispose() {
    this.group.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
    this.stars.forEach((star) => star.material.dispose());
  }
}

/**
 * How being stunned looks, for everyone: pebbles and stars circling over the
 * head of every remote player with `stunned` in their synced
 * `Player.effects`, and a daze over our own view while we have it. Driven per
 * frame from the room state alone, so it shows whatever stunned the player.
 */
export class StunnedLook {
  /** Remote players' markers, by session id. */
  private readonly markers = new Map<string, StunMarker>();
  private readonly vignette: DazeVignette;

  constructor(scene: ArenaScene, private readonly selfId: string) {
    this.vignette = new DazeVignette(scene.camera);
  }

  /**
   * Per frame: `players` is the room's `state.players`, `avatars` the remote
   * players' bodies by session id (we have none: we are the camera).
   */
  update(dt: number, players: Iterable<[string, StunnedLookPlayer]>, avatars: ReadonlyMap<string, Avatar>) {
    let selfStunned = false;
    const stunned = new Set<string>();
    for (const [sessionId, player] of players) {
      if (!isStunned(player)) { continue; }
      if (sessionId === this.selfId) { selfStunned = true; } else { stunned.add(sessionId); }
    }
    this.vignette.update(dt, selfStunned);

    for (const sessionId of stunned) {
      const avatar = avatars.get(sessionId);
      if (!avatar) { continue; }
      const marker = this.markers.get(sessionId);
      if (marker && marker.avatar === avatar) {
        marker.restun();
        continue;
      }
      marker?.dispose();
      this.markers.set(sessionId, new StunMarker(avatar));
    }

    for (const [sessionId, marker] of this.markers) {
      // Gone (left, or a new body): drop it now. No longer stunned: let it fade.
      if (avatars.get(sessionId) !== marker.avatar) {
        marker.dispose();
        this.markers.delete(sessionId);
        continue;
      }
      if (!stunned.has(sessionId)) { marker.fade(); }
      if (!marker.update(dt)) {
        marker.dispose();
        this.markers.delete(sessionId);
      }
    }
  }

  dispose() {
    this.markers.forEach((marker) => marker.dispose());
    this.markers.clear();
    this.vignette.dispose();
  }
}
