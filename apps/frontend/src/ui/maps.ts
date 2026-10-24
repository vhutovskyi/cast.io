import type { MapId } from "@ligma/backend/shared/maps";
import type { SkyDecorSpec } from "../render/skyDecor";

/** How a map looks: colours for the sky, fog, lights and arena surfaces. */
export interface MapTheme {
  /** Background and fog — the same, so the far walls fade into the sky. */
  sky: number;
  fogNear: number;
  fogFar: number;
  /** Hemisphere light: from above, and bounced up from the ground. */
  skyLight: number;
  groundLight: number;
  sun: number;
  /** Defaults: hemisphere 1.2, sun 2 — a clear day. */
  skyLightIntensity?: number;
  sunIntensity?: number;
  /** Towards the sun (or moon) from the arena; default high and to the south-east. */
  sunDirection?: [number, number, number];
  /** Moon, clouds, stars — scenery past the walls. */
  decor?: SkyDecorSpec;
  /** Floor colour; a tint over the texture when there is one. */
  floor: number;
  /** A cloudy floor texture: blotches of `light` over `dark`, lit a little from within by `glow`. */
  cloudFloor?: { light: number; dark: number; glow: number };
  /** Grid lines over the floor; none if omitted. */
  grid?: number;
  /** Wall colour, or false for no walls: the edge is still there, just unseen. */
  wall: number | false;
}

interface MapStyle {
  label: string;
  /** One line under the label in the map picker. */
  blurb: string;
  theme: MapTheme;
}

export const MAP_STYLES: Record<MapId, MapStyle> = {
  sky: {
    label: "Night Sky",
    blurb: "Above the clouds, under the moon",
    theme: {
      sky: 0x0a0f1e, fogNear: 60, fogFar: 210,
      skyLight: 0x7484b8, groundLight: 0x1a1e2a, sun: 0xc8d6ff,
      skyLightIntensity: 1.1, sunIntensity: 1.5,
      // Low in the north-west, so it's in view looking across the arena.
      sunDirection: [-22, 16, -26],
      decor: {
        moon: { color: 0xf2f0e6, glow: 0x9fb4ff, size: 7 },
        clouds: { color: 0x4a505c, glow: 0x1e222b, count: 44, edge: true },
        stars: 900,
      },
      // The arena is a cloud island: cloud underfoot, cloud at the edge, no walls.
      floor: 0xffffff, cloudFloor: { light: 0x7a8294, dark: 0x343a48, glow: 0x161a24 }, wall: false,
    },
  },
  grounds: {
    label: "Proving Grounds",
    blurb: "Open stone yard, nowhere to hide",
    theme: {
      sky: 0x0e1116, fogNear: 30, fogFar: 70,
      skyLight: 0xbfd4ff, groundLight: 0x20242c, sun: 0xffffff,
      floor: 0x2a2f3a, grid: 0x3c4352, wall: 0x4a5163,
    },
  },
  caldera: {
    label: "Ember Caldera",
    blurb: "Scorched rock under a burning sky",
    theme: {
      sky: 0x1a0b08, fogNear: 22, fogFar: 60,
      skyLight: 0xffb38a, groundLight: 0x3a1208, sun: 0xffc59a,
      floor: 0x3a2420, grid: 0x5a2e22, wall: 0x5c3a30,
    },
  },
  frost: {
    label: "Frost Hollow",
    blurb: "Pale ice beneath a cold haze",
    theme: {
      sky: 0xb9c9d8, fogNear: 25, fogFar: 75,
      skyLight: 0xe6f2ff, groundLight: 0x5f7488, sun: 0xdcecff,
      floor: 0x9fb4c6, grid: 0x8199ae, wall: 0x6f8aa3,
    },
  },
};
