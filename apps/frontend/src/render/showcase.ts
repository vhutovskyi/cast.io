import * as THREE from "three";
import { PLAYER_HEIGHT as SIM_PLAYER_HEIGHT } from "@ligma/backend/shared/constants";
import type { MagicElement } from "@ligma/backend/shared/elements";
import { kitOf, type SkillId } from "@ligma/backend/shared/skills";
import { ELEMENT_STYLES } from "../ui/elements";
import type { Showpiece, ShowpieceHolder } from "../skills/showpiece";
import { createFireballShowpiece } from "../skills/fireball/fireball";
import { createWaterWhipShowpiece } from "../skills/waterWhip/waterWhip";
import { createWindPoleShowpiece } from "../skills/windPole/windPole";
import { createStonesShowpiece } from "../skills/stones/stones";
import { WORLD_SCALE, createFigure, createHand, type ArenaScene } from "./scene";

const PLAYER_HEIGHT = SIM_PLAYER_HEIGHT * WORLD_SCALE;
/**
 * The camera stays on the far side of the mage from the moon, turned a little
 * so the moon hangs beside it rather than behind, drifting slowly to and fro.
 */
const MOON_SIDE = 0.15;
const DRIFT = 0.05;
const DRIFT_SPEED = 0.07;
/** Looking up a touch from below the chest: sky and moon in the frame. */
const LOOK_UP = 0.26;
/** How much of the stage's height the body fills. */
const BODY_FILL = 0.5;
/** Narrower than the arena's first-person view, which would bulge the mage; wide enough for the moon. */
const SHOWCASE_FOV = 48;
const RING_RADIUS = 0.8;
/** Floats a little above the cloud, bobbing. */
const HOVER = 0.18;
const BOB = 0.07;

/** Each main skill's held model, as the arena draws it on other players: what the mage carries in the lobby. */
const SHOWPIECES: Partial<Record<SkillId, (holder: ShowpieceHolder) => Showpiece>> = {
  fireball: createFireballShowpiece,
  water_whip: createWaterWhipShowpiece,
  wind_pole: createWindPoleShowpiece,
  stones: createStonesShowpiece,
};

/**
 * The lobby backdrop: the arena with the chosen element's mage hovering in
 * the middle, holding its main skill, the camera circling it slowly. The mage is framed into
 * `stage` — the empty box the menu leaves for it — wherever layout puts it.
 */
export class LobbyShowcase {
  private readonly group = new THREE.Group();
  /** The mage: bobs and turns as one, figure and whatever it holds. */
  private readonly body = new THREE.Group();
  private readonly hand = createHand();
  private figure: THREE.Group | null = null;
  private showpiece: Showpiece | null = null;
  /** Lights the mage's front and the cloud around its feet in its element's colour. */
  private readonly glow = new THREE.PointLight(0xffffff, 5, 7, 1.6);
  private readonly ringMaterial = new THREE.MeshBasicMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  private readonly ring = new THREE.Mesh(new THREE.RingGeometry(RING_RADIUS - 0.16, RING_RADIUS, 64), this.ringMaterial);
  private readonly target = new THREE.Vector3();
  private readonly moon = new THREE.Vector3();
  private readonly reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  private frameId = 0;
  /** The arena's field of view, put back on `stop`. */
  private arenaFov = 0;

  constructor(private readonly arena: ArenaScene, private readonly stage: HTMLElement) {
    this.ring.rotation.x = -Math.PI / 2;
    this.body.add(this.hand);
    this.group.add(this.ring, this.glow, this.body);
  }

  setElement(element: MagicElement) {
    this.showpiece?.dispose();
    if (this.figure) {
      this.body.remove(this.figure);
      this.figure.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          (obj.material as THREE.Material).dispose();
        }
      });
    }
    this.figure = createFigure(element).figure;
    this.body.add(this.figure);
    const main = kitOf(element)?.main;
    const create = main && SHOWPIECES[main];
    this.showpiece = create ? create({ group: this.body, hand: this.hand }) : null;
    const color = ELEMENT_STYLES[element].color;
    this.glow.color.set(color);
    this.ringMaterial.color.set(color);
  }

  start() {
    if (this.frameId) { return; }
    this.arena.scene.add(this.group);
    this.arenaFov = this.arena.camera.fov;
    this.arena.camera.fov = SHOWCASE_FOV;
    const frame = () => {
      this.draw();
      this.frameId = requestAnimationFrame(frame);
    };
    this.frameId = requestAnimationFrame(frame);
  }

  /** Hands the camera back as found: the arena sets it every frame from here on. */
  stop() {
    cancelAnimationFrame(this.frameId);
    this.frameId = 0;
    this.arena.scene.remove(this.group);
    this.arena.camera.fov = this.arenaFov;
    this.arena.camera.clearViewOffset(); // also updates the projection
  }

  private draw() {
    const camera = this.arena.camera;
    // Reduced motion: the same composed shot, held still.
    const t = this.reducedMotion.matches ? 0 : performance.now() / 1000;
    // Where the camera sits round the mage: `angle` 0 is +z, as `sin`/`cos` below place it.
    this.arena.lightDirection(this.moon);
    const angle = Math.atan2(-this.moon.x, -this.moon.z) + MOON_SIDE + Math.sin(t * DRIFT_SPEED) * DRIFT;

    const ground = this.arena.groundAt(0, 0);
    this.group.position.y = ground;
    this.body.position.y = HOVER + Math.sin(t * 1.4) * BOB;
    // Facing the camera (forward is -z), glancing side to side.
    this.body.rotation.y = angle + Math.PI + Math.sin(t * 0.45) * 0.4;
    this.showpiece?.update(t * 1000);
    // Just above the highest bit of cloud under it, so the floor never cuts through.
    let top = ground;
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      top = Math.max(top, this.arena.groundAt(Math.cos(a) * RING_RADIUS, Math.sin(a) * RING_RADIUS));
    }
    this.ring.position.y = top - ground + 0.04;
    this.ringMaterial.opacity = 0.45 + Math.sin(t * 1.4) * 0.12;
    this.glow.position.set(Math.sin(angle) * 1.1, 0.5, Math.cos(angle) * 1.1);

    // Frame the body into the stage box: its height sets the distance, its centre the view offset.
    const width = innerWidth;
    const height = innerHeight;
    const box = this.stage.getBoundingClientRect();
    const stageHeight = box.height > 40 ? box.height : height * 0.5;
    const centreX = box.width > 0 ? box.left + box.width / 2 : width / 2;
    const centreY = box.height > 40 ? box.top + box.height / 2 : height / 2;
    const fill = (BODY_FILL * stageHeight) / height;
    const distance = THREE.MathUtils.clamp(
      PLAYER_HEIGHT / (fill * 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))),
      4, 30,
    );

    this.target.set(0, ground + HOVER + PLAYER_HEIGHT / 2, 0);
    camera.position.set(
      Math.sin(angle) * distance,
      this.target.y - distance * LOOK_UP,
      Math.cos(angle) * distance,
    );
    // Never under the cloud it looks up from.
    camera.position.y = Math.max(camera.position.y, this.arena.groundAt(camera.position.x, camera.position.z) + 0.5);
    camera.lookAt(this.target);
    camera.setViewOffset(width, height, width / 2 - centreX, height / 2 - centreY, width, height);

    this.arena.render(t);
  }
}
