import * as THREE from "three";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import {
  ARENA_WIDTH, ARENA_HEIGHT, PLAYER_HALF,
  PLAYER_HEIGHT as SIM_PLAYER_HEIGHT, EYE_HEIGHT as SIM_EYE_HEIGHT,
} from "@ligma/backend/shared/constants";
import type { MagicElement } from "@ligma/backend/shared/elements";
import { DEFAULT_MAP, MAP_TERRAIN, type MapId } from "@ligma/backend/shared/maps";
import { FLAT, groundHeight, raycastTerrain, type Terrain } from "@ligma/backend/shared/terrain";
import { ELEMENT_STYLES, createElementIcon } from "../ui/elements";
import { MAP_STYLES } from "../ui/maps";
import { createCloudTexture, createSkyDecor, type SkyDecor } from "./skyDecor";

/**
 * The server simulates in its own units: (x, y) across the arena, z up. The
 * scene maps (x, y) onto the 3D ground (x, z) and z onto y, centred on the
 * origin and scaled down so a player is roughly one world unit wide.
 */
export const WORLD_SCALE = 1 / 20;

const ARENA_W = ARENA_WIDTH * WORLD_SCALE;
const ARENA_D = ARENA_HEIGHT * WORLD_SCALE;
const PLAYER_RADIUS = PLAYER_HALF * WORLD_SCALE;
/** Same body the server hit-tests against. */
const PLAYER_HEIGHT = SIM_PLAYER_HEIGHT * WORLD_SCALE;
const PLAYER_LENGTH = PLAYER_HEIGHT - PLAYER_RADIUS * 2;
/** First-person eye height, just under the top of the capsule. */
const EYE_HEIGHT = SIM_EYE_HEIGHT * WORLD_SCALE;
/** Longer than any line across the arena, from any height: aim rays reach the far side. */
const AIM_RAY_LENGTH = 2000;
/** Space between the top of a body and its floating name tag. */
const LABEL_GAP = 0.45;

/** A remote player's 3D body plus its floating name tag and health bar. */
export interface Avatar {
  group: THREE.Group;
  /** Beside the body's right side at chest height, turning with it. Hidden while dead. */
  hand: THREE.Group;
  /** 0..1 — the green part of the bar; the rest shows gray. */
  setHealth(fraction: number): void;
  /** At 0 HP: the body lies on the floor, grayed out. */
  setDead(dead: boolean): void;
}

/** Shared by the floating bars and the first-person HUD bar. */
export function setHealthBar(fill: HTMLElement, fraction: number) {
  fill.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
}

export function toWorld(x: number, y: number, out = new THREE.Vector3()) {
  return out.set((x - ARENA_WIDTH / 2) * WORLD_SCALE, 0, (y - ARENA_HEIGHT / 2) * WORLD_SCALE);
}

/** Inverse of `toWorld`: a ground point (x, z) back to simulation units. */
export function fromWorld(x: number, z: number) {
  return { x: x / WORLD_SCALE + ARENA_WIDTH / 2, y: z / WORLD_SCALE + ARENA_HEIGHT / 2 };
}

/**
 * A mage's body: a capsule in its element's colour with a visor on its -z
 * face, pivoting at the feet. Shared by players in the arena and the lobby's
 * showcase.
 */
export function createFigure(element: MagicElement) {
  const figure = new THREE.Group();

  const bodyMaterial = new THREE.MeshStandardMaterial({ color: ELEMENT_STYLES[element].color, roughness: 0.5 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(PLAYER_RADIUS, PLAYER_LENGTH, 4, 12), bodyMaterial);
  body.position.y = PLAYER_HEIGHT / 2;
  body.castShadow = true;
  figure.add(body);
 
  const visor = new THREE.Mesh(
    new THREE.BoxGeometry(PLAYER_RADIUS * 1.4, 0.18, 0.2),
    new THREE.MeshStandardMaterial({ color: 0xffd24e, emissive: 0x664400 }),
  );
  visor.position.set(0, EYE_HEIGHT, -PLAYER_RADIUS);
  figure.add(visor);

  return { figure, bodyMaterial };
}

/** Where a body holds things (`Avatar.hand`), relative to its feet. */
export function createHand() {
  const hand = new THREE.Group();
  // Forward is -z, so the right hand is +x — slightly ahead of the body.
  hand.position.set(PLAYER_RADIUS + 0.3, PLAYER_HEIGHT * 0.6, -0.2);
  return hand;
}

export class ArenaScene {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(75, 1, 0.05, 200);
  private readonly renderer = new THREE.WebGLRenderer({ antialias: true });
  /** HTML overlay for name tags: crisp text at any distance, no font atlas. */
  private readonly labelRenderer = new CSS2DRenderer();

  constructor(private readonly container: HTMLElement) {
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    container.appendChild(this.renderer.domElement);

    const labels = this.labelRenderer.domElement;
    labels.style.position = "absolute";
    labels.style.inset = "0";
    labels.style.pointerEvents = "none";
    container.appendChild(labels);

    this.scene.background = new THREE.Color();
    this.scene.fog = this.fog;

    // Yaw first, then pitch — the usual first-person order, so looking up and
    // down never rolls the horizon.
    this.camera.rotation.order = "YXZ";
    this.camera.position.set(0, EYE_HEIGHT, 0);
    // In the scene graph so things attached to the view (the first-person
    // fireball) render too.
    this.scene.add(this.camera);

    this.addLights();
    this.addArena();
    this.setMap(DEFAULT_MAP);

    this.resize();
    addEventListener("resize", () => this.resize());
  }

  /**
   * A remote player: a capsule with a visor on its -z face showing where it
   * looks, and its nickname and health bar floating above. The nickname is
   * player-typed, so it only ever goes through `textContent`.
   */
  createPlayer(nickname: string, element: MagicElement): Avatar {
    const group = new THREE.Group();
    // Body and visor share a pivot at the feet, so the whole figure can tip
    // over on death while the name tag stays upright above it.
    const { figure, bodyMaterial } = createFigure(element);
    group.add(figure);

    const hand = createHand();
    group.add(hand);

    const tag = document.createElement("div");
    tag.className = "nametag";
    // Element icon and nickname on one line, directly above the health bar.
    const title = document.createElement("div");
    title.className = "nametag-title";
    const name = document.createElement("span");
    name.textContent = nickname;
    title.append(createElementIcon(element, 16), name);
    const bar = document.createElement("div");
    bar.className = "healthbar";
    const fill = document.createElement("div");
    fill.className = "healthbar-fill";
    bar.append(fill);
    tag.append(title, bar);

    const label = new CSS2DObject(tag);
    label.position.y = PLAYER_HEIGHT + LABEL_GAP;
    group.add(label);

    this.scene.add(group);

    const aliveColor = bodyMaterial.color.clone();
    const deadColor = new THREE.Color(0x4a4f5a);
    return {
      group,
      hand,
      setHealth: (fraction) => setHealthBar(fill, fraction),
      setDead: (dead) => {
        // Lying on its side, resting on the floor, drained of colour.
        figure.rotation.z = dead ? Math.PI / 2 : 0;
        figure.position.y = dead ? PLAYER_RADIUS : 0;
        // The name tag follows the body down instead of floating at head height.
        label.position.y = (dead ? PLAYER_RADIUS * 2 : PLAYER_HEIGHT) + LABEL_GAP;
        bodyMaterial.color.copy(dead ? deadColor : aliveColor);
        tag.classList.toggle("dead", dead);
        hand.visible = !dead;
      },
    };
  }

  removePlayer({ group }: Avatar) {
    this.scene.remove(group);
    group.traverse((obj) => {
      // CSS2DObject only cleans up its element when it is removed itself, not
      // when an ancestor is — so drop the name tag's DOM node here.
      if (obj instanceof CSS2DObject) {
        obj.element.remove();
      }
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        (obj.material as THREE.Material).dispose();
      }
    });
  }

  /** Places the camera at the local player's eyes; `height` is feet above the floor. */
  setFirstPerson(x: number, height: number, z: number, yaw: number, pitch: number) {
    this.camera.position.set(x, height + EYE_HEIGHT, z);
    this.camera.rotation.set(pitch, yaw, 0);
  }

  /**
   * Where the crosshair ray meets the ground, in simulation units, clamped to
   * the arena. Without `maxRange`: null when it never does.
   * With it (`Infinity` allowed): a ray that misses the floor, lands farther
   * than `maxRange` or outside the arena gives the point in the facing
   * direction at `maxRange` or the arena edge, whichever is nearer.
   */
  groundTarget(maxRange?: number): { x: number; y: number } | null {
    const dir = this.aimDir.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const eye = this.camera.position;
    // March the ray over the map's ground in simulation units: the same
    // heightmap the server stands everyone on.
    const from = fromWorld(eye.x, eye.z);
    const hit = raycastTerrain(
      this.terrain,
      { x: from.x, y: from.y, z: eye.y / WORLD_SCALE },
      { x: dir.x, y: dir.z, z: dir.y },
      AIM_RAY_LENGTH,
    );
    let sim = hit && { x: hit.x, y: hit.y };

    if (maxRange !== undefined) {
      const outside = sim && (sim.x < 0 || sim.x > ARENA_WIDTH || sim.y < 0 || sim.y > ARENA_HEIGHT);
      if (!sim || outside || Math.hypot(sim.x - from.x, sim.y - from.y) > maxRange) {
        const flat = Math.hypot(dir.x, dir.z);
        // Looking straight up: no facing direction to go along.
        if (flat < 1e-6) { return null; }
        const dx = dir.x / flat;
        const dy = dir.z / flat;
        const toEdgeX = dx > 0 ? (ARENA_WIDTH - from.x) / dx : dx < 0 ? -from.x / dx : Infinity;
        const toEdgeY = dy > 0 ? (ARENA_HEIGHT - from.y) / dy : dy < 0 ? -from.y / dy : Infinity;
        const reach = Math.max(0, Math.min(maxRange, toEdgeX, toEdgeY));
        sim = { x: from.x + dx * reach, y: from.y + dy * reach };
      }
    }
    if (!sim) { return null; }
    return {
      x: Math.min(ARENA_WIDTH, Math.max(0, sim.x)),
      y: Math.min(ARENA_HEIGHT, Math.max(0, sim.y)),
    };
  }
  private readonly aimDir = new THREE.Vector3();

  /** Towards the sun (or moon) from the arena, as this map lights it. */
  lightDirection(out = new THREE.Vector3()) {
    return out.copy(this.sun.position).normalize();
  }

  /** Feet height of whoever stands at world (x, z), on this map's ground. */
  groundAt(x: number, z: number): number {
    const sim = fromWorld(x, z);
    return groundHeight(this.terrain, sim.x, sim.y) * WORLD_SCALE;
  }

  /** `seconds` drives the sky's drift; hold it still for reduced motion. */
  render(seconds = performance.now() / 1000) {
    this.decor?.update(seconds);
    this.renderer.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);
  }

  /** The map being drawn: its sky, lights and arena colours. Cheap — no geometry is rebuilt but the grid. */
  setMap(map: MapId) {
    if (map === this.map) { return; }
    this.map = map;
    const theme = MAP_STYLES[map].theme;
    this.setTerrain(MAP_TERRAIN[map]);

    (this.scene.background as THREE.Color).set(theme.sky);
    this.fog.color.set(theme.sky);
    this.fog.near = theme.fogNear;
    this.fog.far = theme.fogFar;
    this.hemisphere.color.set(theme.skyLight);
    this.hemisphere.groundColor.set(theme.groundLight);
    this.hemisphere.intensity = theme.skyLightIntensity ?? 1.2;
    this.sun.color.set(theme.sun);
    this.sun.intensity = theme.sunIntensity ?? 2;
    this.sun.position.set(...(theme.sunDirection ?? [12, 30, 10]));
    this.floorMaterial.color.set(theme.floor);
    this.floorMaterial.map?.dispose();
    this.floorMaterial.map = null;
    // Cloud has no shine and a little glow of its own; stone keeps a faint sheen.
    this.floorMaterial.emissive.set(theme.cloudFloor?.glow ?? 0);
    this.floorMaterial.roughness = theme.cloudFloor ? 1 : 0.9;
    if (theme.cloudFloor) {
      const texture = createCloudTexture(theme.cloudFloor.light, theme.cloudFloor.dark);
      // One tile per ~16 world units: broad patches, a few bodies across.
      texture.repeat.set(ARENA_W / 16, ARENA_D / 16);
      this.floorMaterial.map = texture;
    }
    this.floorMaterial.needsUpdate = true;
    // The bounds still stop everyone; a map without walls just doesn't draw them.
    this.walls.visible = theme.wall !== false;
    if (theme.wall !== false) { this.wallMaterial.color.set(theme.wall); }

    // GridHelper bakes its colours into the geometry, so swap in a new one.
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.dispose();
      this.grid = null;
    }
    // A flat grid would cut through hills, so only flat ground gets one.
    if (theme.grid !== undefined && this.terrain === FLAT) {
      // Always square; squash it to the arena's aspect ratio.
      this.grid = new THREE.GridHelper(ARENA_W, 20, theme.grid, theme.grid);
      this.grid.scale.z = ARENA_D / ARENA_W;
      this.grid.position.y = 0.01;
      this.scene.add(this.grid);
    }

    if (this.decor) {
      this.scene.remove(this.decor.group);
      this.decor.dispose();
      this.decor = null;
    }
    if (theme.decor) {
      this.decor = createSkyDecor(theme.decor, this.sun.position, { width: ARENA_W, depth: ARENA_D });
      this.scene.add(this.decor.group);
    }
  }
  /**
   * Bends the floor to the map's heightmap: one vertex per heightmap sample,
   * so what you see is what you stand on.
   */
  private setTerrain(terrain: Terrain) {
    this.terrain = terrain;
    const geometry = new THREE.PlaneGeometry(ARENA_W, ARENA_D, terrain.cols - 1, terrain.rows - 1);
    // Before the floor's -90° tilt: local x is world x, local y is world -z, local z is up.
    const position = geometry.attributes.position;
    for (let k = 0; k < position.count; k++) {
      const sim = fromWorld(position.getX(k), -position.getY(k));
      position.setZ(k, groundHeight(terrain, sim.x, sim.y) * WORLD_SCALE);
    }
    geometry.computeVertexNormals();
    this.floor.geometry.dispose();
    this.floor.geometry = geometry;
  }
  private terrain: Terrain = FLAT;
  private decor: SkyDecor | null = null;
  private map: MapId | null = null;
  private readonly fog = new THREE.Fog(0, 0, 1);
  private readonly hemisphere = new THREE.HemisphereLight();
  private readonly sun = new THREE.DirectionalLight(0xffffff, 2);
  private readonly floorMaterial = new THREE.MeshStandardMaterial({ roughness: 0.9 });
  /** Its geometry follows the map's terrain: see `setTerrain`. */
  private readonly floor = new THREE.Mesh(new THREE.PlaneGeometry(ARENA_W, ARENA_D), this.floorMaterial);
  private readonly wallMaterial = new THREE.MeshStandardMaterial();
  private readonly walls = new THREE.Group();
  private grid: THREE.GridHelper | null = null;

  private addLights() {
    this.scene.add(this.hemisphere);

    const sun = this.sun;
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const cam = sun.shadow.camera;
    cam.left = -ARENA_W / 2 - 2;
    cam.right = ARENA_W / 2 + 2;
    cam.top = ARENA_D / 2 + 2;
    cam.bottom = -ARENA_D / 2 - 2;
    this.scene.add(sun);
  }

  private addArena() {
    const floor = this.floor;
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);

    // Walls along the arena edge, matching the server's clamp bounds. Tall
    // enough to read as a boundary from eye height.
    const thickness = 0.4;
    const height = 2.5;
    const walls: [number, number, number, number][] = [
      [ARENA_W + thickness * 2, thickness, 0, -ARENA_D / 2 - thickness / 2],
      [ARENA_W + thickness * 2, thickness, 0, ARENA_D / 2 + thickness / 2],
      [thickness, ARENA_D, -ARENA_W / 2 - thickness / 2, 0],
      [thickness, ARENA_D, ARENA_W / 2 + thickness / 2, 0],
    ];
    for (const [w, d, x, z] of walls) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(w, height, d), this.wallMaterial);
      wall.position.set(x, height / 2, z);
      wall.castShadow = true;
      wall.receiveShadow = true;
      this.walls.add(wall);
    }
    this.scene.add(this.walls);
  }

  private resize() {
    const { clientWidth, clientHeight } = this.container;
    this.renderer.setSize(clientWidth, clientHeight);
    this.labelRenderer.setSize(clientWidth, clientHeight);
    this.camera.aspect = clientWidth / clientHeight;
    this.camera.updateProjectionMatrix();
  }
}
