import * as THREE from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { PLAYER_HALF } from "@ligma/backend/shared/constants";
import { WORLD_SCALE, type Avatar } from "../../render/scene";
import { onFloor } from "../../render/effects";

/** The tint a clone's body takes: water, lit from within. */
const WATER = 0x5fb8ff;
const WATER_GLOW = 0x1b5f9e;
/** How much of the body shows: a clone is see-through. */
const BODY_OPACITY = 0.5;
/** The circle under our own clone: green, a little wider than a body. */
const OWN_CIRCLE = 0x3ddc5a;
const CIRCLE_RADIUS = PLAYER_HALF * 1.6 * WORLD_SCALE;

/**
 * Turns a mage's avatar into a Water Clone's: every part of the body
 * translucent and tinted like water, the name tag marked as a clone. On our
 * own clone, a green circle on the floor under it too, so we can tell it
 * from the others' — they never see it. Undone by removing the avatar
 * (`ArenaScene.removePlayer` frees everything hung on it).
 */
export function dressAsClone(avatar: Avatar, ours: boolean) {
  avatar.group.traverse((obj) => {
    if (obj instanceof THREE.Mesh && obj.material instanceof THREE.MeshStandardMaterial) {
      const material = obj.material;
      material.transparent = true;
      material.opacity = BODY_OPACITY;
      material.color.lerp(new THREE.Color(WATER), 0.75);
      material.emissive.set(WATER_GLOW);
      // A body of water casts no solid shadow.
      obj.castShadow = false;
    }
    if (obj instanceof CSS2DObject) { obj.element.classList.add("clone"); }
  });

  if (ours) {
    const circle = onFloor(new THREE.Mesh(
      new THREE.RingGeometry(CIRCLE_RADIUS * 0.8, CIRCLE_RADIUS, 40),
      new THREE.MeshBasicMaterial({ color: OWN_CIRCLE, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide }),
    ), 0.05);
    avatar.group.add(circle);
  }
}
