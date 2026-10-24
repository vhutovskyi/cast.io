import * as THREE from "three";

/**
 * What a map hangs in its sky, beyond the arena. Pure scenery: nothing here
 * touches the simulation, so it can differ freely between maps and clients.
 */
export interface SkyDecorSpec {
  /** Sits along the main light's direction, so it casts the shadows it seems to. */
  moon?: { color: number; glow: number; size: number };
  /**
   * Low-poly puffs: a sea below the arena and a ring around the horizon.
   * `glow` lights them a little from within, so backlit ones aren't black.
   * `edge` heaps puffs all along the arena's edge, in place of walls.
   */
  clouds?: { color: number; glow: number; count: number; edge?: boolean };
  /** How many stars, scattered over the upper sky. */
  stars?: number;
}

export interface SkyDecor {
  readonly group: THREE.Group;
  /** Drifts the clouds; `seconds` is any steadily increasing clock. */
  update(seconds: number): void;
  dispose(): void;
}

/** Everything sky-side stays inside the camera's far plane (200). */
const SKY_RADIUS = 170;
/** Radians per second the cloud layers turn around the arena. */
const CLOUD_DRIFT = 0.006;

/**
 * Builds a map's sky scenery. `lightDirection` points from the arena towards
 * the main light; `arena` is its floor's size in world units, centred on the
 * origin. Seeded, so the sky looks the same every time it is built.
 */
export function createSkyDecor(
  spec: SkyDecorSpec, lightDirection: THREE.Vector3, arena: { width: number; depth: number }, seed = 1,
): SkyDecor {
  const random = mulberry32(seed);
  const group = new THREE.Group();
  const drifting: THREE.Object3D[] = [];

  if (spec.stars) { group.add(createStars(spec.stars, random)); }
  if (spec.moon) { group.add(createMoon(spec.moon, lightDirection)); }

  if (spec.clouds) {
    const material = new THREE.MeshStandardMaterial({
      color: spec.clouds.color, emissive: spec.clouds.glow, roughness: 1, flatShading: true,
    });

    // A sea of cloud below the arena's floor, as if the arena floats on it.
    const sea = new THREE.Group();
    for (let i = 0; i < spec.clouds.count; i++) {
      const angle = random() * Math.PI * 2;
      // Starts past the arena's corners, so it shows around the floor, not under it.
      const distance = Math.hypot(arena.width, arena.depth) / 2 + 4 + random() * 90;
      sea.add(createCloud(material, random, Math.cos(angle) * distance, -6 - random() * 8, Math.sin(angle) * distance, 2.5));
    }

    // Banks around the horizon, at and above eye height.
    const ring = new THREE.Group();
    for (let i = 0; i < spec.clouds.count; i++) {
      const angle = random() * Math.PI * 2;
      const distance = 70 + random() * 60;
      ring.add(createCloud(material, random, Math.cos(angle) * distance, 4 + random() * 22, Math.sin(angle) * distance, 5));
    }

    group.add(sea, ring);
    drifting.push(sea, ring);

    if (spec.clouds.edge) { group.add(createCloudEdge(material, arena, random)); }
  }

  return {
    group,
    update(seconds) {
      // The layers turn opposite ways, so the sky reads as moving air.
      drifting.forEach((layer, i) => layer.rotation.y = seconds * CLOUD_DRIFT * (i % 2 ? -0.6 : 1));
    },
    dispose() {
      group.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.Points || obj instanceof THREE.Sprite) {
          obj.geometry.dispose();
          const material = obj.material as THREE.Material & { map?: THREE.Texture | null };
          material.map?.dispose();
          material.dispose();
        }
      });
    },
  };
}

/**
 * Puffs heaped along the arena's edge, straddling it, so the floor ends in
 * cloud instead of a wall. Purely visual: the simulation's bounds are what
 * stop players. One instanced mesh, so a few hundred puffs are one draw call.
 */
function createCloudEdge(material: THREE.Material, { width, depth }: { width: number; depth: number }, random: () => number) {
  const spacing = 1.1;
  const sides: { from: THREE.Vector2; along: THREE.Vector2; length: number; out: THREE.Vector2 }[] = [
    { from: new THREE.Vector2(-width / 2, -depth / 2), along: new THREE.Vector2(1, 0), length: width, out: new THREE.Vector2(0, -1) },
    { from: new THREE.Vector2(-width / 2, depth / 2), along: new THREE.Vector2(1, 0), length: width, out: new THREE.Vector2(0, 1) },
    { from: new THREE.Vector2(-width / 2, -depth / 2), along: new THREE.Vector2(0, 1), length: depth, out: new THREE.Vector2(-1, 0) },
    { from: new THREE.Vector2(width / 2, -depth / 2), along: new THREE.Vector2(0, 1), length: depth, out: new THREE.Vector2(1, 0) },
  ];
  // Two rows: a low one hugging the edge, a bigger one just outside it.
  const rows = [{ offset: 0.5, size: 1.1, height: 0.1 }, { offset: 2.2, size: 1.9, height: -0.2 }];
  const count = rows.length * sides.reduce((sum, side) => sum + Math.ceil(side.length / spacing) + 1, 0);

  const mesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), material, count);
  const matrix = new THREE.Matrix4();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const position = new THREE.Vector3();
  let i = 0;
  for (const row of rows) {
    for (const side of sides) {
      for (let t = 0; t <= side.length + 1e-6; t += spacing) {
        const size = row.size * (0.7 + random() * 0.6);
        const out = row.offset + (random() - 0.5) * 0.8;
        position.set(
          side.from.x + side.along.x * t + side.out.x * out,
          row.height + random() * 0.3,
          side.from.y + side.along.y * t + side.out.y * out,
        );
        rotation.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, random() * Math.PI);
        scale.set(size * 1.3, size * 0.6, size);
        mesh.setMatrixAt(i++, matrix.compose(position, rotation, scale));
      }
    }
  }
  mesh.count = i;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * A tiling cloudy texture for a floor: soft blotches of `light` over `dark`.
 * Periodic value noise, so the tiles meet without seams.
 */
export function createCloudTexture(light: number, dark: number, seed = 7): THREE.CanvasTexture {
  const size = 256;
  const random = mulberry32(seed);
  const octaves = [4, 8, 16, 32].map((cells) => ({ cells, lattice: Array.from({ length: cells * cells }, random) }));

  const smooth = (t: number) => t * t * (3 - 2 * t);
  const noise = (x: number, y: number) => {
    let sum = 0;
    let weight = 0;
    let amplitude = 1;
    for (const { cells, lattice } of octaves) {
      const fx = (x / size) * cells;
      const fy = (y / size) * cells;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const at = (cx: number, cy: number) => lattice[(cy % cells) * cells + (cx % cells)];
      const tx = smooth(fx - x0);
      const ty = smooth(fy - y0);
      const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * tx;
      const bottom = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * tx;
      sum += (top + (bottom - top) * ty) * amplitude;
      weight += amplitude;
      amplitude *= 0.5;
    }
    return sum / weight;
  };

  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const image = ctx.createImageData(size, size);
  const from = new THREE.Color(dark);
  const to = new THREE.Color(light);
  const mixed = new THREE.Color();
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Stretch the middle of the range, so blotches have soft but visible edges.
      const n = Math.min(1, Math.max(0, (noise(x, y) - 0.3) / 0.4));
      mixed.copy(from).lerp(to, n);
      image.data.set([mixed.r * 255, mixed.g * 255, mixed.b * 255, 255], (y * size + x) * 4);
    }
  }
  ctx.putImageData(image, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** A lumpy cloud: a handful of flattened icosahedra, overlapping. Shares one material. */
function createCloud(material: THREE.Material, random: () => number, x: number, y: number, z: number, scale: number) {
  const cloud = new THREE.Group();
  const puffs = 4 + Math.floor(random() * 4);
  for (let i = 0; i < puffs; i++) {
    const radius = (0.8 + random() * 0.9) * scale;
    const puff = new THREE.Mesh(new THREE.IcosahedronGeometry(radius, 1), material);
    puff.position.set((i - puffs / 2) * scale * 0.9 + random() * scale, random() * scale * 0.4, (random() - 0.5) * scale * 1.4);
    puff.scale.y = 0.55;
    cloud.add(puff);
  }
  cloud.position.set(x, y, z);
  cloud.rotation.y = random() * Math.PI;
  return cloud;
}

/** A bright disc with a soft halo, far along the light's direction. Never fogged. */
function createMoon({ color, glow, size }: NonNullable<SkyDecorSpec["moon"]>, direction: THREE.Vector3) {
  const moon = new THREE.Group();
  moon.position.copy(direction).normalize().multiplyScalar(SKY_RADIUS * 0.9);

  const disc = new THREE.Mesh(
    new THREE.SphereGeometry(size, 32, 16),
    new THREE.MeshBasicMaterial({ color, fog: false }),
  );
  moon.add(disc);

  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: createGlowTexture(glow),
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  }));
  halo.scale.setScalar(size * 7);
  moon.add(halo);
  return moon;
}

/** A radial gradient from `color` to transparent, for halos. */
function createGlowTexture(color: number) {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const { r, g, b } = new THREE.Color(color);
  const rgb = `${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}`;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, `rgba(${rgb}, 0.9)`);
  gradient.addColorStop(0.25, `rgba(${rgb}, 0.35)`);
  gradient.addColorStop(1, `rgba(${rgb}, 0)`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Pixel-sized points over the upper half of the sky dome. Never fogged. */
function createStars(count: number, random: () => number) {
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const angle = random() * Math.PI * 2;
    // Mostly up, a few down to just above the horizon.
    const height = 0.05 + random() * 0.95;
    const across = Math.sqrt(1 - height * height);
    positions.set([Math.cos(angle) * across * SKY_RADIUS, height * SKY_RADIUS, Math.sin(angle) * across * SKY_RADIUS], i * 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  return new THREE.Points(geometry, new THREE.PointsMaterial({
    color: 0xdfe6ff, size: 1.6, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.85,
  }));
}

/** Small seeded PRNG: same seed, same sky. */
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
