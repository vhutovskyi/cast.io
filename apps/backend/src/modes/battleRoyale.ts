import type { MatchPhase, Player } from "../rooms/schema/MyRoomState.js";
import { ARENA_WIDTH, ARENA_HEIGHT } from "../shared/constants.js";
import { BATTLE_ROYALE, QUICK_PLAY, type BattleRoyaleSettings } from "../shared/gameModes.js";
import { placeFacingCentre, type GameMode, type ModeRoom } from "./gameMode.js";
import { isWaterClone } from "../skills/waterClone/waterCloneConfig.js";

/**
 * A duel for many, first to `roundsToWin` rounds. Once at least
 * `BATTLE_ROYALE.minPlayers` are seated and every one of them is ready — or,
 * with `autoStart` (Quick Play), as soon as that many are seated — the
 * match starts; each round starts straight away with everyone on a ring of
 * spawns, and ends once at most one is standing — everyone down in the same
 * step is a draw. Nobody respawns mid-round. Whoever joins mid-match sits out
 * (dead) until the next round; the match ends early once fewer than
 * `minPlayers` are left.
 */
export class BattleRoyaleMode implements GameMode {
  /** Which spawn on the ring each seated player starts rounds at. */
  private seats = new Map<string, number>();
  /** Room-clock time (ms) the current timed phase ends. */
  private phaseEndsAt = 0;

  constructor(private readonly room: ModeRoom, private readonly settings: BattleRoyaleSettings, private readonly autoStart = false) {
    const { match } = room.state;
    match.mode = "battleRoyale";
    match.roundsToWin = settings.roundsToWin;
    match.autoStart = autoStart;
    this.setPhase("waiting");
  }

  private get phase() {
    return this.room.state.match.phase as MatchPhase;
  }

  get canDamage() {
    return this.phase === "fighting";
  }

  join(sessionId: string, player: Player) {
    // The lowest free spawn — earlier players may have left.
    const taken = new Set(this.seats.values());
    let seat = 0;
    while (taken.has(seat)) { seat++; }
    this.seats.set(sessionId, seat);
    this.placeAtSpawn(player, seat);
    // Mid-match: watch this round, fight from the next.
    if (this.phase !== "waiting") { player.hp = 0; }
  }

  leave(sessionId: string) {
    this.seats.delete(sessionId);
    if (this.phase === "waiting") {
      // Whoever left may have been the last one not ready.
      this.startIfAllReady();
      return;
    }
    const remaining = this.seated();
    if (remaining.length < BATTLE_ROYALE.minPlayers) { this.endMatch(remaining[0]?.[0] ?? ""); }
  }

  /** Round results are decided in `step`, once the whole step's damage is in. */
  died() {}

  /** Nobody respawns mid-round: the next round brings everyone back. */
  respawn() {}

  /** Toggles; once enough are seated and all of them are ready, the match starts. Unused with `autoStart`. */
  ready(sessionId: string) {
    const player = this.room.state.players.get(sessionId);
    if (!player || this.phase !== "waiting" || this.autoStart) { return; }
    player.ready = !player.ready;
    this.startIfAllReady();
  }

  step() {
    const now = this.room.clock.currentTime;
    const { match } = this.room.state;

    switch (this.phase) {
      case "waiting":
        // Quick Play: no Ready — once the last result has been up long enough, fight whoever is here.
        if (!this.autoStart || now < this.phaseEndsAt) { break; }
        if (this.seated().length >= BATTLE_ROYALE.minPlayers) {
          this.startMatch();
        } else {
          // Too few: stop showing the old result while waiting for more.
          match.matchWinnerId = "";
        }
        break;

      case "fighting": {
        const standing = this.seated().filter(([, player]) => player.hp > 0);
        if (standing.length > 1) { break; }
        const [winnerId, winner] = standing[0] ?? ["", undefined];
        if (winner) { winner.wins++; }
        match.roundWinnerId = winnerId;
        this.setPhase("roundOver", BATTLE_ROYALE.roundOverMs);
        break;
      }

      case "roundOver": {
        if (now < this.phaseEndsAt) { break; }
        // The round's winner may have left during the pause.
        const winner = this.room.state.players.get(match.roundWinnerId);
        if (winner && winner.wins >= match.roundsToWin) {
          this.endMatch(match.roundWinnerId);
        } else {
          this.startRound();
        }
        break;
      }
    }
  }

  private startIfAllReady() {
    const players = this.seated().map(([, p]) => p);
    if (players.length >= BATTLE_ROYALE.minPlayers && players.every((p) => p.ready)) { this.startMatch(); }
  }

  private startMatch() {
    const { match } = this.room.state;
    match.round = 0;
    match.matchWinnerId = "";
    for (const player of this.room.state.players.values()) {
      player.wins = 0;
      player.ready = false;
    }
    this.startRound();
  }

  private startRound() {
    const { match } = this.room.state;
    match.round++;
    match.roundWinnerId = "";
    this.resetArena();
    this.setPhase("fighting");
  }

  /**
   * Back to waiting for Ready, everyone fresh so they can roam meanwhile; the
   * score stays up. With `autoStart`, for `QUICK_PLAY.matchOverMs` before the rematch.
   */
  private endMatch(winnerId: string) {
    this.room.state.match.matchWinnerId = winnerId;
    for (const player of this.room.state.players.values()) { player.ready = false; }
    this.resetArena();
    this.setPhase("waiting", this.autoStart ? QUICK_PLAY.matchOverMs : 0);
  }

  private resetArena() {
    this.room.resetArena();
    for (const [sessionId, player] of this.room.state.players) {
      const seat = this.seats.get(sessionId);
      if (seat !== undefined) { this.placeAtSpawn(player, seat); }
    }
  }

  /** The real players, by session id: a Water Clone is no one's seat, and never stands for a round. */
  private seated(): [string, Player][] {
    return [...this.room.state.players].filter(([, player]) => !isWaterClone(player));
  }

  private setPhase(phase: MatchPhase, durationMs = 0) {
    this.room.state.match.phase = phase;
    this.phaseEndsAt = this.room.clock.currentTime + durationMs;
  }

  /** Evenly spaced around the arena centre, one spawn per seat, facing it. */
  private placeAtSpawn(player: Player, seat: number) {
    const angle = (seat / this.settings.maxPlayers) * Math.PI * 2;
    const { spawnRadius } = BATTLE_ROYALE;
    placeFacingCentre(player, ARENA_WIDTH / 2 + Math.cos(angle) * spawnRadius, ARENA_HEIGHT / 2 + Math.sin(angle) * spawnRadius, this.room.terrain);
  }
}
