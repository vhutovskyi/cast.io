/**
 * Maps: where a room's fight takes place, picked by its creator. Shared code:
 * the backend validates the choice and puts it in the state, the lobby offers
 * it and the scene draws it.
 *
 * Every map shares the same arena bounds (`ARENA_WIDTH` × `ARENA_HEIGHT`).
 * Layout that affects play lives here, so the server and the client's
 * prediction read the same data: so far the ground's shape (`MAP_TERRAIN`).
 * Obstacles and spawns belong here too once maps get them.
 */

import { FLAT, terrainFromHills, type Terrain } from "./terrain.js";

/** Every map, in picker order. */
export const MAPS = ["sky", "grounds", "caldera", "frost"] as const;
export type MapId = (typeof MAPS)[number];

/**
 * Each map's ground. Hilly maps stay unplayable until every skill reads the
 * terrain instead of assuming the floor is at z = 0.
 */
export const MAP_TERRAIN: Readonly<Record<MapId, Terrain>> = {
  sky: FLAT,
  grounds: terrainFromHills([
    { x: 400, y: 300, radius: 150, height: 60 },
    { x: 150, y: 140, radius: 110, height: 45 },
    { x: 660, y: 470, radius: 120, height: 50 },
    { x: 620, y: 130, radius: 90, height: 30 },
    { x: 170, y: 480, radius: 80, height: 25 },
  ]),
  caldera: FLAT,
  frost: FLAT,
};

export const DEFAULT_MAP: MapId = "sky";

/** Maps a room can be made on; the rest are shown in the picker as coming soon. */
export const PLAYABLE_MAPS: readonly MapId[] = ["sky"];

export function isMap(value: unknown): value is MapId {
  return MAPS.includes(value as MapId);
}

export function isPlayable(map: MapId): boolean {
  return PLAYABLE_MAPS.includes(map);
}

/**
 * The room creator's choice, validated: omitted means the default, anything
 * that isn't a playable map is null. Never trust the wire.
 */
export function parseMap(map: unknown): MapId | null {
  const id = map ?? DEFAULT_MAP;
  return isMap(id) && isPlayable(id) ? id : null;
}
