import * as THREE from "three";

/** A short-lived visual. `update` returns false once finished. */
export interface Effect {
  update(dt: number): boolean;
  dispose(): void;
}

/** Runs effects every frame and disposes them when they finish. */
export class Effects {
  private active: Effect[] = [];

  add<E extends Effect>(effect: E): E {
    this.active.push(effect);
    return effect;
  }

  /**
   * Over a snapshot: an effect may add others while it updates (e.g. a blast
   * once its streams meet) — those are kept, and start next frame.
   */
  update(dt: number) {
    for (const effect of [...this.active]) {
      if (effect.update(dt)) { continue; }
      effect.dispose();
      this.active.splice(this.active.indexOf(effect), 1);
    }
  }

  clear() {
    this.active.forEach((effect) => effect.dispose());
    this.active = [];
  }
}

/** Glowing, depth-friendly material for beams and rings. */
export function glowMaterial(color: number, opacity = 0) {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

/** A flat mesh lying on the floor (geometries are built in the XY plane). */
export function onFloor(mesh: THREE.Mesh, height = 0.03) {
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = height;
  return mesh;
}

let glowTexture: THREE.Texture | undefined;

/**
 * A soft round glow for sprites: white at the centre fading to nothing at the
 * edge, tinted by the sprite's colour. Shared by every glow, never disposed.
 */
export function glowSprite(color: number, opacity = 0) {
  if (!glowTexture) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext("2d")!;
    const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    gradient.addColorStop(0, "#fff");
    gradient.addColorStop(0.35, "#ffffffaa");
    gradient.addColorStop(1, "#fff0");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 64, 64);
    glowTexture = new THREE.CanvasTexture(canvas);
  }
  return new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture,
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  }));
}

/** Removes a group from its parent and frees every geometry and material in it. */
export function disposeGroup(group: THREE.Object3D) {
  group.removeFromParent();
  group.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.geometry.dispose();
      (obj.material as THREE.Material).dispose();
    }
    // Sprites share one geometry inside three.js: free only their material.
    if (obj instanceof THREE.Sprite) {
      obj.material.dispose();
    }
  });
}
