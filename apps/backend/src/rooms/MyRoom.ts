import { Room, Client, CloseCode, ServerError, Rewind, RewindView, type StepContext } from "colyseus";
import { MyRoomState, Player, MoveInput } from "./schema/MyRoomState.js";
import { stepEntity, deadInput, clearForcedMotion } from "../shared/movement.js";
import { TICK_RATE, ROOM_NAME_MAX, NICKNAME_MAX, MAX_HP } from "../shared/constants.js";
import { CLIENT_MESSAGE, SERVER_MESSAGE } from "../shared/messages.js";
import { INPUT_ACTION, MAX_INPUT_ACTION } from "../shared/actions.js";
import type { DamageOptions, DamageSource, KillEvent } from "../shared/combat.js";
import { DEFAULT_ELEMENT, isPlayableElement, type MagicElement } from "../shared/elements.js";
import { maxClientsOf, parseGameMode, type GameModeConfig, type GameModeId, type GameModeSettings } from "../shared/gameModes.js";
import { MAP_TERRAIN, parseMap, type MapId } from "../shared/maps.js";
import { FLAT, type Terrain } from "../shared/terrain.js";
import type { Obstacle } from "../shared/obstacles.js";
import { LIVE, type SeenAt, type ServerSkill, type SkillRoom } from "../skills/skillRoom.js";
import { SunStrikeSkill } from "../skills/sunStrike/sunStrike.js";
import { FireballSkill } from "../skills/fireball/fireball.js";
import { FlameBreathSkill } from "../skills/flameBreath/flameBreath.js";
import { TwinDragonsSkill } from "../skills/twinDragons/twinDragons.js";
import { WaterWhipSkill } from "../skills/waterWhip/waterWhip.js";
import { TorrentSkill } from "../skills/torrent/torrent.js";
import { WaterCloneSkill } from "../skills/waterClone/waterClone.js";
import { isWaterClone, sparedAsOwnClone } from "../skills/waterClone/waterCloneConfig.js";
import { FreezingStreamSkill } from "../skills/freezingStream/freezingStream.js";
import { StoneSkinSkill } from "../skills/stoneSkin/stoneSkin.js";
import { EarthWallSkill } from "../skills/earthWall/earthWall.js";
import { StonesSkill } from "../skills/stones/stones.js";
import { BouldersSkill } from "../skills/boulders/boulders.js";
import { RuptureSkill } from "../skills/rupture/rupture.js";
import { BurrowSkill } from "../skills/burrow/burrow.js";
import { WindPoleSkill } from "../skills/windPole/windPole.js";
import { LeapSkill } from "../skills/leap/leap.js";
import { PuffSkill } from "../skills/puff/puff.js";
import { SkyfallSkill } from "../skills/skyfall/skyfall.js";
import { StatusEffects } from "../effects/statusEffects.js";
import { blockedByWalls, canCast, isUntargetable, moveLimits } from "../effects/effectConfig.js";
import { GroundZones } from "../effects/groundZones.js";
import { InputPacer } from "./inputPacer.js";
import type { GameMode, ModeRoom } from "../modes/gameMode.js";
import { FreeForAllMode } from "../modes/freeForAll.js";
import { DuelMode } from "../modes/duel.js";
import { BattleRoyaleMode } from "../modes/battleRoyale.js";

/** Damage dealt by the dev-only `debug_damage` message. */
const DEBUG_DAMAGE = 10;

/**
 * Furthest back a hit may be judged, in ms: the longest a client draws others
 * behind (its 250 ms interpolation delay, the 65 ms smoothing after it, half
 * its round trip) on a sluggish connection. Past it, a victim long behind a
 * wall on their own screen is spared.
 */
export const MAX_REWIND_MS = 400;

/** Options a client passes to `create()` / `joinById()`, or to `joinOrCreate()` for Quick Play. */
export interface ArenaOptions {
  /**
   * Quick Play: the matchmaker puts the player in an open Quick Play room of
   * `mode` (`filterBy` in `app.config.ts`), or creates one — which then runs
   * the mode's default settings, whatever `settings` says, and starts matches
   * without Ready. Only read when the room is created.
   */
  quickPlay?: boolean;
  /** Shown in the room list; only read when the room is created. */
  name?: string;
  /** Shown above the player's character to everyone in the room. */
  nickname?: string;
  /** Must be a playable element (one with a kit); omitted means the default. */
  element?: MagicElement;
  /** The room's rules; only read when the room is created. Omitted means free-for-all. */
  mode?: GameModeId;
  /** For the chosen mode; clamped to its limits, the rest defaulted. Only read when the room is created. */
  settings?: Partial<GameModeSettings[GameModeId]>;
  /** Where the room fights; only read when the room is created. Omitted means the default map. */
  map?: MapId;
}

/**
 * Listed publicly by the lobby — never put anything private in here. Also
 * what the matchmaker filters Quick Play on (`mode`, `quickPlay`).
 */
export type ArenaMetadata = { name: string; map: MapId; quickPlay: boolean } & GameModeConfig;

/**
 * Room names and nicknames are player-typed text broadcast to other players:
 * keep printable characters only, collapse whitespace, cap the length.
 */
export function sanitizeText(raw: unknown, maxLength: number): string {
  if (typeof raw !== "string") { return ""; }
  return raw.replace(/\p{C}/gu, "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

export class MyRoom extends Room<{ state: MyRoomState, input: MoveInput, metadata: ArenaMetadata }> {
  maxClients = 8;
  state = new MyRoomState();

  /**
   * One state patch per simulation step (the default is 20 Hz), so remote
   * players get a fresh sample every tick instead of two ticks folded into one.
   */
  patchRate = 1000 / TICK_RATE;

  /**
   * Per-client input buffer. `sanitize` clamps every field as it is decoded —
   * never trust the wire — and the buffer holds ~2s of inputs at this tick rate
   * so a burst after a stall still replays in order.
   */
  inputs = this.defineInput(MoveInput, {
    bufferMaxSize: 2 * TICK_RATE,
    sanitize: { moveX: [-1, 1], moveY: [-1, 1], yaw: [-Math.PI, Math.PI], act: [0, MAX_INPUT_ACTION] },
  });

  /** Hands each player's inputs to the step at a steady pace. */
  private pacer = new InputPacer();

  /**
   * Whoever a hit took to 0 since the last step ended, with the hit that did
   * it: cast messages between steps, then the step itself. Their body is dead
   * at once — 0 health, so nothing targets, pushes, launches or slows it —
   * but they keep acting (`canAct`) until the step is done, then all die
   * together: two mages who kill each other on the same step both go down,
   * whoever's turn or message came first.
   */
  private dying = new Map<string, DamageSource | undefined>();

  /** Recent positions of everyone, for lag compensation (`seenBy`). Set in `onCreate`, before anyone joins. */
  private rewind: Rewind;

  /** The map's ground, set in `onCreate`: everyone stands on it. */
  private terrain: Terrain = FLAT;

  /**
   * Each skill's server logic, built in `onCreate` around `skillRoom()`. Every
   * element's skills live in every room; each cast checks the caster's kit.
   */
  private sunStrike: SunStrikeSkill;
  private fireball: FireballSkill;
  private flameBreath: FlameBreathSkill;
  private twinDragons: TwinDragonsSkill;
  private waterWhip: WaterWhipSkill;
  private torrent: TorrentSkill;
  private waterClone: WaterCloneSkill;
  private freezingStream: FreezingStreamSkill;
  private stoneSkin: StoneSkinSkill;
  private earthWall: EarthWallSkill;
  private stones: StonesSkill;
  private boulders: BouldersSkill;
  private rupture: RuptureSkill;
  private burrow: BurrowSkill;
  private windPole: WindPoleSkill;
  private leap: LeapSkill;
  private puff: PuffSkill;
  private skyfall: SkyfallSkill;
  /** All of the above, for what the room does with every skill alike. */
  private skills: ServerSkill[] = [];

  /** Status effects on players, and the ground zones that apply them. */
  private effects: StatusEffects;
  private zones: GroundZones;

  /** The room's rules: free-for-all, duel, … Chosen by its creator. */
  private mode: GameMode;

  messages = {
    // movement arrives through the input buffer above — register handlers here
    // only for things that are not inputs (chat, emotes, …).

    /** Dev aid until real attacks exist: hurt yourself. Ignored in production. */
    [CLIENT_MESSAGE.debugDamage]: (client: Client) => {
      if (process.env.NODE_ENV === "production") { return; }
      this.damage(client.sessionId, DEBUG_DAMAGE);
    },

    [CLIENT_MESSAGE.sunStrike]: (client: Client, message: unknown) => this.mayCast(client) && this.sunStrike.cast(client, message),

    [CLIENT_MESSAGE.fireball]: (client: Client, message: unknown) => this.mayCast(client) && this.fireball.cast(client, message),

    [CLIENT_MESSAGE.twinDragons]: (client: Client, message: unknown) => this.mayCast(client) && this.twinDragons.cast(client, message),

    [CLIENT_MESSAGE.waterWhip]: (client: Client, message: unknown) => this.mayCast(client) && this.waterWhip.cast(client, message),

    [CLIENT_MESSAGE.torrent]: (client: Client, message: unknown) => this.mayCast(client) && this.torrent.cast(client, message),

    [CLIENT_MESSAGE.waterClone]: (client: Client, message: unknown) => this.mayCast(client) && this.waterClone.cast(client, message),

    [CLIENT_MESSAGE.freezingStream]: (client: Client, message: unknown) => this.mayCast(client) && this.freezingStream.cast(client, message),

    [CLIENT_MESSAGE.stoneSkin]: (client: Client) => this.mayCast(client) && this.stoneSkin.cast(client),

    [CLIENT_MESSAGE.earthWall]: (client: Client, message: unknown) => this.mayCast(client) && this.earthWall.cast(client, message),

    [CLIENT_MESSAGE.earthWallDetonate]: (client: Client) => this.mayCast(client) && this.earthWall.detonate(client),

    [CLIENT_MESSAGE.stones]: (client: Client, message: unknown) => this.mayCast(client) && this.stones.cast(client, message),

    [CLIENT_MESSAGE.boulderRaise]: (client: Client) => this.mayCast(client) && this.boulders.raise(client),

    [CLIENT_MESSAGE.boulderKick]: (client: Client, message: unknown) => this.mayCast(client) && this.boulders.kick(client, message),

    [CLIENT_MESSAGE.burrow]: (client: Client) => this.mayCast(client) && this.burrow.cast(client),

    // Not gated on `mayCast`: being under the ground forbids every other cast, not this one.
    [CLIENT_MESSAGE.burrowErupt]: (client: Client) => this.burrow.erupt(client),

    [CLIENT_MESSAGE.rupture]: (client: Client, message: unknown) => this.mayCast(client) && this.rupture.cast(client, message),

    [CLIENT_MESSAGE.windPole]: (client: Client, message: unknown) => this.mayCast(client) && this.windPole.cast(client, message),

    [CLIENT_MESSAGE.leap]: (client: Client, message: unknown) => this.mayCast(client) && this.leap.cast(client, message),

    [CLIENT_MESSAGE.puff]: (client: Client, message: unknown) => this.mayCast(client) && this.puff.cast(client, message),

    [CLIENT_MESSAGE.skyfall]: (client: Client, message: unknown) => this.mayCast(client) && this.skyfall.cast(client, message),

    // Not gated on `mayCast`: once up, a frozen or stunned mage still comes down.
    [CLIENT_MESSAGE.skyfallDrop]: (client: Client, message: unknown) => this.skyfall.drop(client, message),

    /** The Respawn button: whether and when it works is the mode's call. */
    [CLIENT_MESSAGE.respawn]: (client: Client) => this.mode.respawn(client.sessionId),

    /** The Ready button (duel). */
    [CLIENT_MESSAGE.ready]: (client: Client) => this.mode.ready(client.sessionId),
  };

  /** Whether the sender may cast anything right now: no effect on them forbids it (frozen). */
  private mayCast(client: Client): boolean {
    const player = this.state.players.get(client.sessionId);
    return player !== undefined && canCast(player.effects);
  }

  /**
   * The single way health goes down: whole points, never below zero, scaled
   * by the victim's status effects. Attacks call this once they have resolved
   * a hit on the server. A survived hit with a `source` applies that ability's
   * on-hit effects; the hit that takes a player to 0 leaves a body that is
   * dead to every hit and effect from then on, and kills them (`die`) at the
   * end of the step (`dying`). A Water Clone, which never acts, dies at
   * once. Ignored while the mode says hits don't count (a duel between
   * rounds), and on a player out of reach (under the ground). A Water Clone
   * takes no hits from its owner.
   */
  damage(sessionId: string, amount: number, source?: DamageSource, options?: DamageOptions) {
    const player = this.state.players.get(sessionId);
    if (!player || player.hp <= 0 || !(amount > 0) || !this.mode.canDamage || isUntargetable(player.effects)) { return; }
    if (sparedAsOwnClone(player, source?.id)) { return; }
    const hp = Math.max(0, player.hp - Math.round(amount * this.effects.damageTakenScale(sessionId)));

    player.hp = hp;
    if (hp > 0) {
      if (source && !options?.fromEffect) { this.effects.applyOnHit(sessionId, source); }
    } else if (isWaterClone(player)) {
      this.die(sessionId, player, source);
    } else {
      this.dying.set(sessionId, source);
    }
  }

  /** `SkillRoom.canAct`: alive, or killed since the last step ended (`dying`). */
  canAct(sessionId: string): boolean {
    const player = this.state.players.get(sessionId);
    return player !== undefined && (player.hp > 0 || this.dying.has(sessionId));
  }

  /**
   * A body at 0 health dies: clears their effects, tells the game mode and
   * goes out to the kill feed. A Water Clone's death is nobody's kill: the
   * clone's skill clears it away next step.
   */
  private die(sessionId: string, player: Player, source: DamageSource | undefined) {
    this.effects.clear(sessionId);
    // A body doesn't keep sliding or hover in the sky: it falls where it died.
    clearForcedMotion(player);
    if (isWaterClone(player)) { return; }
    this.mode.died(sessionId);
    this.broadcast(SERVER_MESSAGE.kill, {
      victimId: sessionId, victimName: player.name, killer: source,
    } satisfies KillEvent);
  }

  onCreate(options: ArenaOptions) {
    const quickPlay = options?.quickPlay === true;
    // The lobby only offers real modes, so anything else is a modified client.
    // Quick Play rooms all run the defaults: a player can't size one by creating it.
    const config = parseGameMode(options?.mode, quickPlay ? undefined : options?.settings);
    if (!config) { throw new ServerError(400, "That game mode doesn't exist."); }
    // Same for maps: the lobby only offers real ones.
    const map = parseMap(options?.map);
    if (!map) { throw new ServerError(400, "That map doesn't exist."); }

    this.maxClients = maxClientsOf(config);
    this.state.match.map = map;
    this.terrain = MAP_TERRAIN[map];
    // Replaces the matchmaker's own metadata (0.18): `mode` and `quickPlay` must be in here for `filterBy`.
    this.setMetadata({ name: sanitizeText(options?.name, ROOM_NAME_MAX) || `Arena ${this.roomId}`, map, quickPlay, ...config });
    this.setFixedTimestep((ctx) => this.step(ctx), TICK_RATE);
    // Recorded with every patch, so it holds exactly the positions clients were sent.
    this.rewind = this.allowRewindState({ maxRewindMs: MAX_REWIND_MS });
    this.rewind.attachAll(this.state.players, { fields: ["x", "y", "z"] });

    this.effects = new StatusEffects(this);
    this.zones = new GroundZones(this, this.effects);

    const skillRoom = this.skillRoom();
    this.sunStrike = new SunStrikeSkill(skillRoom);
    this.fireball = new FireballSkill(skillRoom);
    this.flameBreath = new FlameBreathSkill(skillRoom);
    this.twinDragons = new TwinDragonsSkill(skillRoom);
    this.waterWhip = new WaterWhipSkill(skillRoom);
    this.torrent = new TorrentSkill(skillRoom);
    // Clones lash with the whip's own combo; once one is gone, nothing else keeps anything on it.
    this.waterClone = new WaterCloneSkill(skillRoom, this.waterWhip, this.terrain, (cloneId) => {
      for (const skill of this.skills) { if (skill !== this.waterClone) { skill.remove(cloneId); } }
      this.effects.clear(cloneId);
    });
    this.freezingStream = new FreezingStreamSkill(skillRoom);
    this.stoneSkin = new StoneSkinSkill(skillRoom);
    this.earthWall = new EarthWallSkill(skillRoom);
    this.stones = new StonesSkill(skillRoom);
    this.boulders = new BouldersSkill(skillRoom);
    this.rupture = new RuptureSkill(skillRoom);
    this.burrow = new BurrowSkill(skillRoom);
    this.windPole = new WindPoleSkill(skillRoom);
    this.leap = new LeapSkill(skillRoom);
    this.puff = new PuffSkill(skillRoom);
    this.skyfall = new SkyfallSkill(skillRoom);
    this.skills = [
      this.sunStrike, this.fireball, this.flameBreath, this.twinDragons,
      this.waterWhip, this.torrent, this.waterClone, this.freezingStream,
      this.stones, this.stoneSkin, this.boulders, this.earthWall, this.burrow, this.rupture,
      this.windPole, this.leap, this.puff, this.skyfall,
    ];

    const modeRoom = this.modeRoom();
    switch (config.mode) {
      case "ffa": this.mode = new FreeForAllMode(modeRoom); break;
      case "duel": this.mode = new DuelMode(modeRoom, config.settings, quickPlay); break;
      case "battleRoyale": this.mode = new BattleRoyaleMode(modeRoom, config.settings, quickPlay); break;
    }
  }

  /** The narrow view of this room the game mode works through. */
  private modeRoom(): ModeRoom {
    return {
      state: this.state,
      clock: this.clock,
      terrain: this.terrain,
      resetArena: () => this.resetArena(),
    };
  }

  /**
   * Everyone back to full health, and nothing left over from before: no
   * effects, cooldowns, projectiles, charging strikes, ground fire or deaths
   * still to land. Clients
   * hear about it after the patch with the new positions, so they can face
   * where they now stand.
   */
  private resetArena() {
    for (const skill of this.skills) { skill.reset(); }
    this.dying.clear();
    for (const player of this.state.players.values()) { clearForcedMotion(player); }
    this.zones.clear();
    this.effects.clearAll();
    for (const player of this.state.players.values()) { player.hp = MAX_HP; }
    this.broadcast(SERVER_MESSAGE.arenaReset, undefined, { afterNextPatch: true });
  }

  /** The narrow view of this room the skills work through. */
  private skillRoom(): SkillRoom {
    return {
      state: this.state,
      clock: this.clock,
      broadcast: (type, message) => this.broadcast(type, message),
      send: (sessionId, type, message) => this.clients.getById(sessionId)?.send(type, message),
      damage: (sessionId, amount, source, options) => this.damage(sessionId, amount, source, options),
      canAct: (sessionId) => this.canAct(sessionId),
      // Out of reach (under the ground), only their own effects land on them.
      // Nothing of a Water Clone's owner lands on it.
      applyEffect: (sessionId, id, source, durationMs) =>
        ((this.untargetable(sessionId) && source?.id !== sessionId) || sparedAsOwnClone(this.state.players.get(sessionId), source?.id)
          ? false : this.effects.apply(sessionId, id, source, durationMs)),
      removeEffect: (sessionId, id) => this.effects.remove(sessionId, id),
      addGroundZone: (zone) => this.zones.add(zone),
      seenBy: (sessionId, atInput) => this.seenAgo(this.lagOf(sessionId, atInput)),
      lagOf: (sessionId, atInput) => this.lagOf(sessionId, atInput),
      seenAgo: (lagMs) => this.seenAgo(lagMs),
    };
  }

  /**
   * `SkillRoom.lagOf`. Every input carries the server time its sender's
   * screen showed others at (the client keeps that stamp in step with how far
   * behind it draws them). The last applied input's stamp is that moment for
   * it; the newest received is one tick later per input still queued behind
   * it — and a cast message comes right after the newest. Capped at
   * `MAX_REWIND_MS`, so nobody reaches further into the past.
   */
  private lagOf(sessionId: string, atInput = false): number {
    const channel = this.inputs.get(sessionId);
    const stamp = channel?.renderTime ?? 0;
    if (!channel || !(stamp > 0)) { return 0; }
    const seenAt = atInput ? stamp : stamp + channel.size * (1000 / TICK_RATE);
    return Math.min(MAX_REWIND_MS, Math.max(0, this.clock.elapsedTime - seenAt));
  }

  /** `SkillRoom.seenAgo`: read from the positions recorded with each patch. */
  private seenAgo(lagMs: number): SeenAt {
    if (!(lagMs > 0)) { return LIVE; }
    const view = this.rewind.at(this.clock.elapsedTime - lagMs, new RewindView());
    return (player) => ({ x: view.value(player, "x"), y: view.value(player, "y"), z: view.value(player, "z") });
  }

  /** Whether a player is out of everyone else's reach right now (under the ground). */
  private untargetable(sessionId: string): boolean {
    const player = this.state.players.get(sessionId);
    return player !== undefined && isUntargetable(player.effects);
  }

  onJoin(client: Client, options: ArenaOptions) {
    // The lobby only offers playable elements, so anything else is a modified
    // client: refuse the seat rather than guess.
    const element = options?.element ?? DEFAULT_ELEMENT;
    if (!isPlayableElement(element)) {
      throw new ServerError(400, "That element can't be played yet.");
    }

    console.log(client.sessionId, "joined!");

    const player = new Player({
      name: sanitizeText(options?.nickname, NICKNAME_MAX) || `Mage ${client.sessionId.slice(0, 4)}`,
      hp: MAX_HP,
      element,
      x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, dashVx: 0, dashVy: 0, dashTime: 0, flightZ: 0, breathing: false, ready: false, wins: 0,
      // A real player, not a Water Clone.
      ownerId: "",
    });
    this.mode.join(client.sessionId, player);
    this.state.players.set(client.sessionId, player);
  }

  onLeave(client: Client, code: CloseCode) {
    console.log(client.sessionId, "left!", code);
    this.state.players.delete(client.sessionId);
    // A strike or fireball already in the air still lands; only the cooldowns go.
    for (const skill of this.skills) { skill.remove(client.sessionId); }
    this.effects.clear(client.sessionId);
    this.pacer.remove(client.sessionId);
    // Last: a duel's forfeit resets the arena for whoever is still here.
    this.mode.leave(client.sessionId);
  }

  onDispose() {
    console.log("room", this.roomId, "disposing...");
  }

  /**
   * The skill pressed in one of `sessionId`'s inputs (`MoveInput.act`), if
   * any — each checks whether they may, as its own message would. Bursting
   * out of the ground and choosing where to drop aren't casts: no `mayCast`.
   */
  private act(sessionId: string, player: Player, input: MoveInput) {
    const mayCast = canCast(player.effects);
    switch (input.act) {
      case INPUT_ACTION.leap: if (mayCast) { this.leap.castFromInput(sessionId, input.yaw); } break;
      case INPUT_ACTION.skyfall: if (mayCast) { this.skyfall.castFromInput(sessionId); } break;
      case INPUT_ACTION.skyfallDrop: this.skyfall.dropFromInput(sessionId, { x: input.aimX, y: input.aimY }); break;
      case INPUT_ACTION.burrow: if (mayCast) { this.burrow.castFromInput(sessionId); } break;
      case INPUT_ACTION.burrowErupt: this.burrow.eruptFromInput(sessionId); break;
    }
  }

  /**
   * One shared `stepEntity` per received input, so the set the client predicted
   * is exactly the set the server applied. A client that sends nothing simply
   * does not move — an empty tick advances no one. Flame Breath channels in
   * step with those inputs; fireballs and Twin Dragons fly after, then ground zones apply
   * their effects and effects tick and wear off. Whoever was killed since the
   * last step — by this one or a cast between — dies after all of that
   * (`dying`), before the mode judges the step.
   */
  private step(ctx: StepContext) {
    for (const [sessionId, player] of this.state.players) {
      const channel = this.inputs.get(sessionId);
      if (!channel) { continue; }

      // Paced, not drained: one input per tick (two when catching up), so a
      // bursty connection doesn't turn into a freeze-then-teleport.
      for (const input of this.pacer.take(sessionId, channel)) {
        // A skill that moves them, pressed on this step, starts before it — as their client predicted.
        if (this.canAct(sessionId)) { this.act(sessionId, player, input); }
        // Dead players' inputs are still consumed (so nothing replays after
        // respawn) but replaced: they can't walk, jump or breathe, only fall.
        // Killed this step, they still act on it.
        // The living breathe only when the skill allows it — before the step,
        // since breathing slows the walk.
        // Status effects limit it all: a slow, a freeze that stops walking,
        // jumping and breathing — read from the synced list, as the client does.
        const command = this.canAct(sessionId) ? this.flameBreath.vet(sessionId, player, input, canCast(player.effects)) : deadInput(player.yaw);
        // Under the ground, walls don't stop them: the client predicts the same from the synced effects.
        const walls: Iterable<Obstacle> = blockedByWalls(player.effects) ? this.state.walls.values() : [];
        stepEntity(player, command, ctx.dt, moveLimits(player.effects), walls, this.terrain);
        this.flameBreath.advance(sessionId, player, command.breath, ctx.dt);
        for (const skill of this.skills) { skill.afterInput?.(sessionId, player); }
      }
      this.flameBreath.settle(sessionId, player);
    }

    for (const skill of this.skills) { skill.step?.(ctx.dt); }
    this.zones.step();
    this.effects.step();

    for (const [sessionId, source] of this.dying) {
      const player = this.state.players.get(sessionId);
      if (player) { this.die(sessionId, player, source); }
    }
    this.dying.clear();
    this.mode.step();
  }

  /**
   * Called on any disconnection the client did not ask for — a network blip, a
   * suspended tab, a tunnel change. Holding the seat lets the SDK retry into the
   * same session, so the player keeps their entity and their place in the room.
   */
  onDrop(client: Client, code: CloseCode) {
    // Deliberately not awaited: the framework routes the outcome to onReconnect()
    // or onLeave() by itself. The catch is only here because the promise also
    // rejects when the room is already disposing (server shutdown), which would
    // otherwise surface as an unhandled rejection.
    this.allowReconnection(client, 30).catch(() => {});
  }

  onReconnect(client: Client) {
    console.log(client.sessionId, "reconnected!");
  }
}
