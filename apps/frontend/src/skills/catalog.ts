import type { SkillId } from "@ligma/backend/shared/skills";
import { createFireballIcon } from "./fireball/fireballIcon";
import { createSunStrikeIcon } from "./sunStrike/sunStrikeIcon";
import { createFlameBreathIcon } from "./flameBreath/flameBreathIcon";
import { createTwinDragonsIcon } from "./twinDragons/twinDragonsIcon";
import { createWaterWhipIcon } from "./waterWhip/waterWhipIcon";
import { createWaterCloneIcon } from "./waterClone/waterCloneIcon";
import { createTorrentIcon } from "./torrent/torrentIcon";
import { createFreezingStreamIcon } from "./freezingStream/freezingStreamIcon";
import { createStoneSkinIcon } from "./stoneSkin/stoneSkinIcon";
import { createEarthWallIcon } from "./earthWall/earthWallIcon";
import { createStonesIcon } from "./stones/stonesIcon";
import { createBouldersIcon } from "./boulders/bouldersIcon";
import { createBurrowIcon } from "./burrow/burrowIcon";
import { createRuptureIcon } from "./rupture/ruptureIcon";
import { createWindPoleIcon } from "./windPole/windPoleIcon";
import { createLeapIcon } from "./leap/leapIcon";
import { createPuffIcon } from "./puff/puffIcon";
import { createSkyfallIcon } from "./skyfall/skyfallIcon";

export interface SkillInfo {
  name: string;
  /** How to use it, if not a plain click: shown in the controls help line. */
  hint?: string;
  icon: (size: number) => SVGSVGElement;
}

/** How every skill is shown: ability bar, key settings, kill feed. Which slot it takes is its element's kit. */
export const SKILLS: Readonly<Record<SkillId, SkillInfo>> = {
  fireball: { name: "Fireball", icon: createFireballIcon },
  sun_strike: { name: "Sun Strike", icon: createSunStrikeIcon },
  flame_breath: { name: "Flame Breath", hint: "hold click", icon: createFlameBreathIcon },
  twin_dragons: { name: "Twin Dragons", icon: createTwinDragonsIcon },
  water_whip: { name: "Water Whip", icon: createWaterWhipIcon },
  water_clone: { name: "Water Clone", hint: "after whoever you aim at", icon: createWaterCloneIcon },
  torrent: { name: "Torrent", icon: createTorrentIcon },
  freezing_stream: { name: "Freezing Stream", icon: createFreezingStreamIcon },
  stones: { name: "Stone Fists", icon: createStonesIcon },
  stone_skin: { name: "Stone Skin", icon: createStoneSkinIcon },
  boulders: { name: "Boulders", hint: "near one: again or click to kick it", icon: createBouldersIcon },
  earth_wall: { name: "Earth Wall", hint: "again to blow it up", icon: createEarthWallIcon },
  burrow: { name: "Burrow", hint: "click under ground to burst out", icon: createBurrowIcon },
  rupture: { name: "Rupture", icon: createRuptureIcon },
  wind_pole: { name: "Wind Pole", icon: createWindPoleIcon },
  leap: { name: "Leap", icon: createLeapIcon },
  puff: { name: "Puff", icon: createPuffIcon },
  skyfall: { name: "Skyfall", hint: "click again to drop", icon: createSkyfallIcon },
};
