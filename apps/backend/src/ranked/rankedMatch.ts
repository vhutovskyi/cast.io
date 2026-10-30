import { CloseCode, ServerError, type Clock, type Delayed } from "colyseus";
import { SERVER_MESSAGE } from "../shared/messages.js";
import { RANKED, RANKED_CLOSE_CODE, type RankedCancelled, type RankedResult } from "../shared/ranked.js";
import { ranked, type MatchSeat, type Ranked, type RankedMatchTicket } from "./ranked.js";

/** The slice of the match room a ranked match works through. */
export interface RankedRoom {
  /** The room clock: the join deadline and the result hold run on it. */
  readonly clock: Clock;
  send(sessionId: string, type: string, message: unknown): void;
  /** Ends the duel now, `winnerSessionId` winning because the other left. Its result comes back through `finished`. */
  forfeit(winnerSessionId: string): void;
  /** Sends everyone still here back to the menu with `code` (default: a normal close), and closes the room. */
  close(code?: number): void;
}

/**
 * One ranked match in its room, from the queue pairing two players to the
 * result — and the one judge of what leaving means. Before both have joined,
 * failing to show up within `RANKED.joinTimeoutMs`, or leaving, is a dodge:
 * the match is called off and the dodger locked out of the queue. Once both
 * are in, leaving forfeits, whether or not the first round has begun; a
 * dropped connection gets its seat held (and the fight paused) for whatever
 * is left of `RANKED.disconnectBudgetMs`, and is a leave once that runs out.
 * A forfeit goes to whoever is still playing: if the other is disconnected
 * too, they win only by coming back, and if they never do either, the match
 * is void.
 */
export class RankedMatch {
  /** Session id → seat, for each who took theirs (kept after they leave). */
  private seated = new Map<string, MatchSeat>();
  /** Both seats have been taken: leaving forfeits instead of dodging. */
  private started = false;
  /** The first to leave the started match, so its result is a forfeit. */
  private forfeiter: string | undefined;
  /** Session ids who left the started match for good. */
  private gone = new Set<string>();
  /** Rating id → ms spent disconnected so far this match. */
  private disconnectedMs = new Map<string, number>();
  /** Session id → room-clock time (ms) they dropped, while their seat is held. */
  private droppedAt = new Map<string, number>();
  private joinDeadline: Delayed;
  private closeTimer: Delayed | undefined;
  /** The server is shutting down and waiting for this match: until when, before voiding it. */
  private drainTimer: Delayed | undefined;

  constructor(private readonly room: RankedRoom, readonly ticket: RankedMatchTicket, private readonly service: Ranked = ranked) {
    this.joinDeadline = room.clock.setTimeout(() => this.noShow(), RANKED.joinTimeoutMs);
  }

  /** Decided or called off. */
  get settled() {
    return !this.service.isOpen(this.ticket.id);
  }

  /**
   * The seat a joiner may take. `rankedId` comes from the seat reservation
   * the queue made, never from a client. Throws for anyone else.
   */
  admit(options: { rankedId?: unknown } | undefined): MatchSeat {
    if (this.settled) { throw new ServerError(410, "This ranked match was called off."); }
    const seat = this.ticket.seats.find((s) => s.ratingId === options?.rankedId);
    if (!seat || [...this.seated.values()].includes(seat)) { throw new ServerError(403, "There's no seat for you in this ranked match."); }
    return seat;
  }

  joined(sessionId: string, seat: MatchSeat) {
    this.seated.set(sessionId, seat);
    if (this.seated.size === this.ticket.seats.length) {
      this.started = true;
      this.joinDeadline.clear();
    }
  }

  /** Seconds to hold their seat for; 0 when they have none left (or nothing is at stake) — they're gone. */
  dropped(sessionId: string): number {
    const seat = this.seated.get(sessionId);
    if (!seat || this.settled) { return 0; }
    const leftMs = RANKED.disconnectBudgetMs - (this.disconnectedMs.get(seat.ratingId) ?? 0);
    if (leftMs < 1000) { return 0; }
    this.droppedAt.set(sessionId, this.room.clock.currentTime);
    return Math.floor(leftMs / 1000);
  }

  reconnected(sessionId: string) {
    this.countDisconnect(sessionId);
    // Back after the other left for good while both were away: theirs is the forfeit win.
    if (this.forfeiter !== undefined && !this.settled) { this.room.forfeit(sessionId); }
  }

  /** Gone for good (left, or out of disconnect time). Call before the duel hears of it. */
  left(sessionId: string) {
    this.countDisconnect(sessionId);
    const seat = this.seated.get(sessionId);
    if (!seat || this.settled) { return; }
    if (!this.started) {
      this.callOff([seat.ratingId]);
      return;
    }
    this.gone.add(sessionId);
    this.forfeiter ??= sessionId;
    const opponent = [...this.seated.keys()].find((id) => !this.gone.has(id));
    if (opponent === undefined) {
      // Both gone, neither came back: abandoned by both, nobody's result.
      this.service.cancel(this.ticket.id);
      this.room.close();
    } else if (!this.droppedAt.has(opponent)) {
      this.room.forfeit(opponent);
    }
    // Otherwise the opponent is disconnected too: decided when they come back, or leave as well.
  }

  /** From the duel: the match is decided. Rates both and tells them; the room closes a while later. */
  finished(winnerSessionId: string) {
    if (this.settled) { return; }
    const winner = this.seated.get(winnerSessionId);
    const changes = winner && this.service.finish(this.ticket.id, winner.ratingId);
    if (!changes) {
      // Nobody left to win it: nothing to rate.
      this.service.cancel(this.ticket.id);
      this.room.close();
      return;
    }
    for (const [sessionId, seat] of this.seated) {
      const change = changes.get(seat.ratingId)!;
      this.room.send(sessionId, SERVER_MESSAGE.rankedResult, {
        won: seat === winner,
        forfeit: this.forfeiter !== undefined,
        ratingBefore: change.before,
        ratingAfter: change.after,
        deviation: change.deviation,
      } satisfies RankedResult);
    }
    // A deploy waiting on this room: no need to keep the result up for long.
    this.closeTimer = this.room.clock.setTimeout(() => this.room.close(), this.drainTimer ? RANKED.shutdownResultHoldMs : RANKED.resultHoldMs);
  }

  /**
   * The server is shutting down (a deploy). A match under way is played out,
   * for up to `RANKED.shutdownDrainMs`, then voided after all; one not yet
   * started is called off now, nobody at fault. Returns whether this keeps the
   * room open (else close it: nothing left to wait for).
   */
  drain(): boolean {
    if (this.settled) { return false; }
    if (!this.started) {
      this.abandonForRestart();
      return true;
    }
    this.drainTimer ??= this.room.clock.setTimeout(() => this.abandonForRestart(), RANKED.shutdownDrainMs);
    return true;
  }

  /** The room is going: whatever wasn't settled by now is nobody's fault (the server is closing). */
  dispose() {
    this.joinDeadline.clear();
    this.closeTimer?.clear();
    this.drainTimer?.clear();
    this.service.cancel(this.ticket.id);
  }

  /**
   * Voided by a server restart that can't wait: no result, no penalty, and
   * both told why — by message, and by the close code, which arrives even
   * when a message sent right after joining wouldn't.
   */
  private abandonForRestart() {
    if (this.settled) { return; }
    this.joinDeadline.clear();
    this.service.cancel(this.ticket.id);
    for (const sessionId of this.seated.keys()) {
      this.room.send(sessionId, SERVER_MESSAGE.rankedCancelled, { reason: "serverRestart" } satisfies RankedCancelled);
    }
    this.room.close(CloseCode.SERVER_SHUTDOWN);
  }

  /** The join deadline passed with a seat still empty. */
  private noShow() {
    const present = new Set(this.seated.values());
    this.callOff(this.ticket.seats.filter((seat) => !present.has(seat)).map((seat) => seat.ratingId));
  }

  private callOff(dodgerIds: string[]) {
    this.joinDeadline.clear();
    this.service.dodged(this.ticket.id, dodgerIds);
    for (const [sessionId, seat] of this.seated) {
      if (!dodgerIds.includes(seat.ratingId)) {
        this.room.send(sessionId, SERVER_MESSAGE.rankedCancelled, { reason: "opponentDodged" } satisfies RankedCancelled);
      }
    }
    this.room.close(RANKED_CLOSE_CODE.calledOff);
  }

  private countDisconnect(sessionId: string) {
    const since = this.droppedAt.get(sessionId);
    const seat = this.seated.get(sessionId);
    if (since === undefined || !seat) { return; }
    this.droppedAt.delete(sessionId);
    this.disconnectedMs.set(seat.ratingId, (this.disconnectedMs.get(seat.ratingId) ?? 0) + this.room.clock.currentTime - since);
  }
}
