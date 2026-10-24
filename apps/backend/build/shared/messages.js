/**
 * Every message name sent between client and server, in one place so the two
 * sides can't drift apart. Shared code: imported by the backend and frontend.
 */
/** Client → server, handled by the arena room's `messages`. */
export const CLIENT_MESSAGE = {
    /** Dev only: hurt yourself. Ignored in production. */
    debugDamage: "debug_damage",
    /** Cast Sun Strike at a ground point — payload `SunStrikeCast`. */
    sunStrike: "sun_strike",
    /** Throw a fireball along the view — payload `FireballAim`. */
    fireball: "fireball",
    /** Cast Twin Dragons at a ground point — payload `TwinDragonsCast`. */
    twinDragons: "twin_dragons",
    /** Crack the water whip along the view — payload `WaterWhipAim`. */
    waterWhip: "water_whip",
    /** Cast Torrent at a ground point — payload `TorrentCast`. */
    torrent: "torrent",
    /** Send out a water clone, at the enemy under the aim if any — payload defined in `waterCloneConfig`. */
    waterClone: "water_clone",
    /** Fire the freezing stream (water's ultimate) — payload defined in `freezingStreamConfig`. */
    freezingStream: "freezing_stream",
    /** Punch the next stone fist along the view — payload `StonesAim`. */
    stones: "stones",
    /** Harden into Stone Skin. No payload. */
    stoneSkin: "stone_skin",
    /** Raise a boulder ahead of you. No payload. */
    boulderRaise: "boulder_raise",
    /** Kick the boulder you stand at along this facing — payload `BoulderKick`. */
    boulderKick: "boulder_kick",
    /** Raise an earth wall at a ground point — payload `EarthWallCast`. */
    earthWall: "earth_wall",
    /** Blow up your standing earth wall. No payload. */
    earthWallDetonate: "earth_wall_detonate",
    /** Dig into the ground and travel under it. No payload. */
    burrow: "burrow",
    /** While burrowed: burst out of the ground, hurting everyone near. No payload. */
    burrowErupt: "burrow_erupt",
    /** Tear the ground open in a fan ahead — payload defined in `ruptureConfig`. */
    rupture: "rupture",
    /** Swing the wind pole along the view — payload defined in `windPoleConfig`. */
    windPole: "wind_pole",
    /** Leap along the ground — payload defined in `leapConfig`. */
    leap: "leap",
    /** Puff nearby enemies away. Payload, if any, defined in `puffConfig`. */
    puff: "puff",
    /** Soar high into the sky (wind's ultimate) — payload defined in `skyfallConfig`. */
    skyfall: "skyfall",
    /** While soaring: drop onto a ground point — payload defined in `skyfallConfig`. */
    skyfallDrop: "skyfall_drop",
    /** The Respawn button; ignored unless the sender is dead. */
    respawn: "respawn",
    /** Duel: the Ready button, toggles; ignored mid-match. */
    ready: "ready",
};
/** Server → client, sent by the arena room. */
export const SERVER_MESSAGE = {
    /** To the caster only — payload `SunStrikeCharging`. */
    sunStrikeCharging: "sun_strike_charging",
    /** To everyone — payload `SunStrikeHit`. */
    sunStrikeHit: "sun_strike_hit",
    /** To everyone — payload `FireballCast`. */
    fireballCast: "fireball_cast",
    /** To everyone — payload `FireballHit`. */
    fireballHit: "fireball_hit",
    /** To the caster only, when their channel ends — payload `FlameBreathEnd`. */
    flameBreathEnd: "flame_breath_end",
    /** To the caster only — payload `TwinDragonsLaunch`. */
    twinDragonsLaunch: "twin_dragons_launch",
    /** To everyone, every step while the streams fly — payload `TwinDragonsHeads`. */
    twinDragonsHeads: "twin_dragons_heads",
    /** To everyone — payload `TwinDragonsBlast`. */
    twinDragonsBlast: "twin_dragons_blast",
    /** To everyone — payload `WaterWhipCast`. */
    waterWhipCast: "water_whip_cast",
    /** To the caster only — payload `TorrentCharging`. */
    torrentCharging: "torrent_charging",
    /** To everyone — payload `TorrentHit`. */
    torrentHit: "torrent_hit",
    /** To everyone: Water Whip's third hit, a shard in flight — payload defined in `waterWhipConfig`. */
    whipShardCast: "whip_shard_cast",
    /** To everyone: where a whip shard shattered — payload defined in `waterWhipConfig`. */
    whipShardHit: "whip_shard_hit",
    /** To everyone — payload defined in `waterCloneConfig`. */
    waterCloneCast: "water_clone_cast",
    /** To everyone: a clone is gone (killed, or its owner died or left) — payload defined in `waterCloneConfig`. */
    waterCloneEnd: "water_clone_end",
    /** To everyone — payload defined in `freezingStreamConfig`. */
    freezingStreamCast: "freezing_stream_cast",
    /** To everyone — payload defined in `freezingStreamConfig`. */
    freezingStreamHit: "freezing_stream_hit",
    /** To everyone — payload `StoneFistPunched`. */
    stoneFistPunched: "stone_fist_punched",
    /** To everyone — payload `StoneFistHit`. */
    stoneFistHit: "stone_fist_hit",
    /** To everyone — payload `StoneSkinCast`. */
    stoneSkinCast: "stone_skin_cast",
    /** To everyone — payload `StoneSkinContact`. */
    stoneSkinContact: "stone_skin_contact",
    /** To the caster only — payload `BoulderRaised`. */
    boulderRaised: "boulder_raised",
    /** To everyone — payload `BoulderKicked`. */
    boulderKicked: "boulder_kicked",
    /** To everyone — payload `BoulderHit`. */
    boulderHit: "boulder_hit",
    /** To the caster only — payload `EarthWallRaised`. */
    earthWallRaised: "earth_wall_raised",
    /** To everyone — payload `EarthWallBlast`. */
    earthWallBlast: "earth_wall_blast",
    /** To everyone — payload defined in `burrowConfig`. */
    burrowCast: "burrow_cast",
    /** To everyone — payload defined in `burrowConfig`. */
    burrowSurface: "burrow_surface",
    /** To everyone — payload defined in `ruptureConfig`. */
    ruptureCast: "rupture_cast",
    /** To everyone — payload defined in `windPoleConfig`. */
    windPoleCast: "wind_pole_cast",
    /** To everyone — payload defined in `windPoleConfig`. */
    windPoleHit: "wind_pole_hit",
    /** To everyone — payload defined in `leapConfig`. */
    leapCast: "leap_cast",
    /** To everyone — payload defined in `leapConfig`. */
    leapHit: "leap_hit",
    /** To everyone — payload defined in `puffConfig`. */
    puffCast: "puff_cast",
    /** To everyone — payload defined in `skyfallConfig`. */
    skyfallRise: "skyfall_rise",
    /** To everyone — payload defined in `skyfallConfig`. */
    skyfallDrop: "skyfall_drop",
    /** To everyone — payload defined in `skyfallConfig`. */
    skyfallLand: "skyfall_land",
    /** To everyone, for the kill feed — payload `KillEvent`. */
    kill: "kill",
    /**
     * To everyone, right after the patch that put everyone back at full health
     * at their spawns (a duel's new round or match end): drop every cooldown,
     * projectile and effect being drawn. No payload.
     */
    arenaReset: "arena_reset",
};
/** Server → client, sent by Colyseus' built-in LobbyRoom (names fixed by Colyseus). */
export const LOBBY_MESSAGE = {
    /** Full room list, on join. */
    rooms: "rooms",
    /** A room was added or updated. */
    upsert: "+",
    /** A room was removed. */
    remove: "-",
};
