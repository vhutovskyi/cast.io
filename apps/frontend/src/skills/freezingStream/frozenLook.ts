import * as THREE from "three";
import { PLAYER_HALF, PLAYER_HEIGHT } from "@ligma/backend/shared/constants";
import { type ArenaScene, type Avatar, WORLD_SCALE } from "../../render/scene";
import { glowSprite, disposeGroup } from "../../render/effects";

/** The effect this draws, by its server id. */
const FROZEN = "frozen";

/** The block round a body, in world units: a little wider and taller than the body. */
const BLOCK_RADIUS = PLAYER_HALF * WORLD_SCALE * 1.75;
const BLOCK_HEIGHT = PLAYER_HEIGHT * WORLD_SCALE * 1.12;
/** Ice spikes jutting out of the block, and glints twinkling on it. */
const SPIKES = 9;
const SPARKLES = 7;
/** It snaps shut over this, and thaws away over the next, in seconds. */
const FREEZE_S = 0.12;
const THAW_S = 0.3;

/** The frost over our own view: how far in front of the camera it hangs (inside the near plane's reach), and how fast it comes and goes. */
const VIGNETTE_DISTANCE = 0.1;
const VIGNETTE_IN_S = 0.15;
const VIGNETTE_OUT_S = 0.45;
const VIGNETTE_TEXTURE_SIZE = 512;

/** Cones are built pointing up. */
const UP = new THREE.Vector3(0, 1, 0);

/** What this reads off a synced `Player`. */
export interface FrozenLookPlayer {
  hp: number;
  effects: Iterable<string>;
}

function isFrozen(player: FrozenLookPlayer) {
  if (player.hp <= 0) { return false; }
  for (const id of player.effects) {
    if (id === FROZEN) { return true; }
  }
  return false;
}

/**
 * A translucent block of ice round a remote player's body, hung on their
 * avatar so it goes wherever they are drawn: a six-sided crystal with frosted
 * edges, spikes jutting out of it and glints twinkling across it. It snaps
 * shut, and melts away once the freeze is over.
 */
class IceBlock {
  readonly group = new THREE.Group();
  private readonly material = new THREE.MeshStandardMaterial({
    color: 0xa8e4ff, emissive: 0x1b5a80, emissiveIntensity: 0.6, roughness: 0.08, metalness: 0.15,
    transparent: true, opacity: 0, depthWrite: false, flatShading: true, side: THREE.DoubleSide,
  });
  private readonly edgeMaterial = new THREE.LineBasicMaterial({ color: 0xe8f8ff, transparent: true, opacity: 0, depthWrite: false });
  private readonly edges: THREE.LineSegments;
  private readonly sparkles = Array.from({ length: SPARKLES }, (_, i) => {
    const sprite = glowSprite(0xffffff);
    const angle = (i / SPARKLES) * Math.PI * 2 + Math.random();
    sprite.position.set(Math.cos(angle) * BLOCK_RADIUS * 0.95, BLOCK_HEIGHT * (0.1 + 0.85 * Math.random()), Math.sin(angle) * BLOCK_RADIUS * 0.95);
    this.group.add(sprite);
    return { sprite, rate: 2 + Math.random() * 3, phase: Math.random() * Math.PI * 2 };
  });
  private readonly haze = glowSprite(0x6fc8ff);
  /** Seconds since it froze; and since it began to thaw, NaN while still frozen. */
  private age = 0;
  private thawing = NaN;

  constructor(readonly avatar: Avatar) {
    // Slightly narrower at the top, like a block of ice grown up round them.
    const prism = new THREE.CylinderGeometry(BLOCK_RADIUS * 0.9, BLOCK_RADIUS, BLOCK_HEIGHT, 6, 1);
    const block = new THREE.Mesh(prism, this.material);
    block.position.y = BLOCK_HEIGHT / 2;
    block.rotation.y = Math.random() * Math.PI;
    this.edges = new THREE.LineSegments(new THREE.EdgesGeometry(prism), this.edgeMaterial);
    this.edges.position.copy(block.position);
    this.edges.rotation.copy(block.rotation);
    this.group.add(block, this.edges);

    for (let i = 0; i < SPIKES; i++) {
      const length = BLOCK_RADIUS * (0.5 + 0.6 * Math.random());
      const spike = new THREE.Mesh(new THREE.ConeGeometry(BLOCK_RADIUS * 0.16, length, 5), this.material);
      const angle = (i / SPIKES) * Math.PI * 2 + Math.random() * 0.4;
      // Low round the feet and high round the shoulders, pointing outward and up.
      const height = BLOCK_HEIGHT * (i % 3 === 0 ? 0.85 : 0.08 + 0.25 * Math.random());
      spike.position.set(Math.cos(angle) * BLOCK_RADIUS * 0.95, height, Math.sin(angle) * BLOCK_RADIUS * 0.95);
      spike.quaternion.setFromUnitVectors(UP, new THREE.Vector3(Math.cos(angle), 0.7, Math.sin(angle)).normalize());
      this.group.add(spike);
    }

    this.haze.position.y = BLOCK_HEIGHT / 2;
    this.haze.scale.set(BLOCK_RADIUS * 3, BLOCK_HEIGHT * 1.3, 1);
    this.group.add(this.haze);
    avatar.group.add(this.group);
  }

  /** The freeze is over: melt away. */
  thaw() {
    if (Number.isNaN(this.thawing)) { this.thawing = 0; }
  }

  /** Frozen again before it melted away: back to solid. */
  refreeze() {
    if (!Number.isNaN(this.thawing)) { this.thawing = NaN; }
  }

  /** False once it has melted away. */
  update(dt: number) {
    const t = (this.age += dt);
    const shut = Math.min(t / FREEZE_S, 1);
    if (!Number.isNaN(this.thawing)) { this.thawing += dt; }
    const left = Number.isNaN(this.thawing) ? 1 : Math.max(0, 1 - this.thawing / THAW_S);
    const show = shut * left;

    // Grows up from the feet as it snaps shut; slumps a little as it melts.
    this.group.scale.set(1 + 0.05 * (1 - left), shut * (0.85 + 0.15 * left), 1 + 0.05 * (1 - left));
    this.material.opacity = 0.5 * show;
    this.edgeMaterial.opacity = 0.7 * show;
    this.haze.material.opacity = 0.25 * show;
    for (const { sprite, rate, phase } of this.sparkles) {
      const twinkle = Math.max(0, Math.sin(t * rate + phase)) ** 6;
      sprite.material.opacity = twinkle * show;
      sprite.scale.setScalar(0.12 + 0.35 * twinkle);
    }
    return left > 0;
  }

  dispose() {
    disposeGroup(this.group);
    // Not a mesh: `disposeGroup` leaves it.
    this.edges.geometry.dispose();
    this.edgeMaterial.dispose();
  }
}

/**
 * The frost creeping in round the edges of a canvas: clear in the middle,
 * pale ice at the rim, with feathery crystals reaching inward.
 */
function createFrostTexture() {
  const size = VIGNETTE_TEXTURE_SIZE;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const half = size / 2;

  const rim = ctx.createRadialGradient(half, half, size * 0.28, half, half, size * 0.72);
  rim.addColorStop(0, "rgba(216, 244, 255, 0)");
  rim.addColorStop(0.55, "rgba(170, 225, 255, 0.35)");
  rim.addColorStop(1, "rgba(235, 250, 255, 0.9)");
  ctx.fillStyle = rim;
  ctx.fillRect(0, 0, size, size);

  // Crystals: branching strokes from the rim toward the middle.
  ctx.strokeStyle = "rgba(240, 252, 255, 0.55)";
  ctx.lineCap = "round";
  const branch = (x: number, y: number, angle: number, length: number, width: number, depth: number) => {
    const toX = x + Math.cos(angle) * length;
    const toY = y + Math.sin(angle) * length;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(toX, toY);
    ctx.stroke();
    if (depth <= 0) { return; }
    const spread = 0.5 + Math.random() * 0.3;
    branch(toX, toY, angle - spread, length * 0.6, width * 0.7, depth - 1);
    branch(toX, toY, angle + spread, length * 0.6, width * 0.7, depth - 1);
    branch(toX, toY, angle + (Math.random() - 0.5) * 0.3, length * 0.7, width * 0.75, depth - 1);
  };
  for (let i = 0; i < 40; i++) {
    const around = Math.random() * Math.PI * 2;
    const x = half + Math.cos(around) * half * 1.05;
    const y = half + Math.sin(around) * half * 1.05;
    branch(x, y, around + Math.PI + (Math.random() - 0.5) * 0.6, size * (0.06 + 0.06 * Math.random()), 2.5, 3);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * Frost over our own view while we are frozen: a sheet hung just in front of
 * the camera, sized to fill it, clear in the middle and iced over at the
 * edges. Drawn over everything else.
 */
class FrostVignette {
  private readonly texture = createFrostTexture();
  private readonly material = new THREE.MeshBasicMaterial({
    map: this.texture, transparent: true, opacity: 0, depthTest: false, depthWrite: false,
  });
  private readonly mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.material);
  private shown = 0;
  private time = 0;

  constructor(private readonly camera: THREE.PerspectiveCamera) {
    this.mesh.position.z = -VIGNETTE_DISTANCE;
    this.mesh.renderOrder = 999;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    camera.add(this.mesh);
  }

  update(dt: number, frozen: boolean) {
    this.time += dt;
    this.shown = frozen
      ? Math.min(1, this.shown + dt / VIGNETTE_IN_S)
      : Math.max(0, this.shown - dt / VIGNETTE_OUT_S);
    this.mesh.visible = this.shown > 0;
    if (!this.mesh.visible) { return; }

    // Exactly fills the view at its distance, a touch oversized so the rim stays off screen edges.
    const height = 2 * VIGNETTE_DISTANCE * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) * 1.04;
    this.mesh.scale.set(height * this.camera.aspect, height, 1);
    this.material.opacity = this.shown * (0.9 + 0.1 * Math.sin(this.time * 3));
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}

/**
 * How being frozen looks, for everyone: a block of ice round every remote
 * player with `frozen` in their synced `Player.effects`, and frost over our
 * own view while we have it. Driven per frame from the room state alone, so
 * it shows whatever froze the player.
 */
export class FrozenLook {
  /** Remote players' blocks, by session id. */
  private readonly blocks = new Map<string, IceBlock>();
  private readonly vignette: FrostVignette;

  constructor(scene: ArenaScene, private readonly selfId: string) {
    this.vignette = new FrostVignette(scene.camera);
  }

  /**
   * Per frame: `players` is the room's `state.players`, `avatars` the remote
   * players' bodies by session id (we have none: we are the camera).
   */
  update(dt: number, players: Iterable<[string, FrozenLookPlayer]>, avatars: ReadonlyMap<string, Avatar>) {
    let selfFrozen = false;
    const frozen = new Set<string>();
    for (const [sessionId, player] of players) {
      if (!isFrozen(player)) { continue; }
      if (sessionId === this.selfId) { selfFrozen = true; } else { frozen.add(sessionId); }
    }
    this.vignette.update(dt, selfFrozen);

    for (const sessionId of frozen) {
      const avatar = avatars.get(sessionId);
      if (!avatar) { continue; }
      const block = this.blocks.get(sessionId);
      if (block && block.avatar === avatar) {
        block.refreeze();
        continue;
      }
      block?.dispose();
      this.blocks.set(sessionId, new IceBlock(avatar));
    }

    for (const [sessionId, block] of this.blocks) {
      // Gone (left, or a new body): drop it now. No longer frozen: let it melt.
      if (avatars.get(sessionId) !== block.avatar) {
        block.dispose();
        this.blocks.delete(sessionId);
        continue;
      }
      if (!frozen.has(sessionId)) { block.thaw(); }
      if (!block.update(dt)) {
        block.dispose();
        this.blocks.delete(sessionId);
      }
    }
  }

  dispose() {
    this.blocks.forEach((block) => block.dispose());
    this.blocks.clear();
    this.vignette.dispose();
  }
}
