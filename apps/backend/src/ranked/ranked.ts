import { randomUUID } from "node:crypto";
import { RANKED } from "../shared/ranked.js";
import type { MagicElement } from "../shared/elements.js";
import { database } from "../accounts/database.js";
import { idleDeviation, rate, type Glicko } from "./glicko2.js";
import { SqliteRatingStore, type RatingRecord, type RatingStore } from "./ratingStore.js";

/** One of the two players in a ranked match, as the queue paired them. */
export interface MatchSeat {
  /** Their account id: what ratings and bans are kept under. */
  ratingId: string;
  name: string;
  element: MagicElement;
  rating: number;
  /** Wall-clock ms they started searching: kept if a dodger sends them back. */
  queuedAt: number;
}

/** A match the queue made, until it's decided or called off. */
export interface RankedMatchTicket {
  id: string;
  seats: readonly [MatchSeat, MatchSeat];
}

/** How one player's rating moved in a match. */
export interface RatingChange {
  before: number;
  after: number;
  deviation: number;
}

const fresh = (): RatingRecord => ({
  rating: RANKED.initialRating,
  deviation: RANKED.initialDeviation,
  volatility: RANKED.initialVolatility,
  games: 0,
  wins: 0,
  lastPlayedAt: 0,
  dodges: 0,
  lastDodgeAt: 0,
  bannedUntil: 0,
});

/**
 * Ranked play across rooms: who is who, their ratings, the matches the queue
 * has made, and the penalties. The queue room makes matches, the match room
 * reports how they ended. One per process (`ranked`): the rooms reach it
 * directly, so this only works on a single server process.
 */
export class Ranked {
  /** Wall clock: ratings, lockouts and queue places outlive any room. */
  now: () => number = Date.now;

  private loaded: RatingStore | undefined;
  /** Made and not yet decided or called off, by match id. */
  private matches = new Map<string, RankedMatchTicket & { claimed: boolean }>();
  /** Rating id → the match they're in. */
  private playing = new Map<string, string>();
  /** Rating id → where they were in the queue before a dodger pulled them out. */
  private priority = new Map<string, { queuedAt: number; until: number }>();

  constructor(private readonly openStore: () => RatingStore) {}

  /** Opened on first use, so importing this never touches the disk. */
  get store(): RatingStore {
    return this.loaded ??= this.openStore();
  }

  /** Tests: start over with `store`, nothing in flight. */
  reset(store: RatingStore, now: () => number = Date.now) {
    this.loaded = store;
    this.now = now;
    this.matches.clear();
    this.playing.clear();
    this.priority.clear();
  }

  /** Their record as it stands now, deviation grown over the time away. Not saved. */
  standing(id: string): RatingRecord {
    const record = this.store.get(id) ?? fresh();
    return { ...record, deviation: idleDeviation(record, this.periodsSince(record.lastPlayedAt), RANKED.initialDeviation) };
  }

  /** Why they can't search right now, or null if they can. */
  queueRefusal(id: string): string | null {
    if (this.playing.has(id)) { return "You're already in a ranked match."; }
    const wait = (this.store.get(id)?.bannedUntil ?? 0) - this.now();
    if (wait > 0) { return `You dodged a ranked match: you can queue again in ${Math.ceil(wait / 1000)}s.`; }
    return null;
  }

  /** When they first started searching, if a dodger recently sent them back: they keep their place. Once. */
  takePriority(id: string): number | undefined {
    const kept = this.priority.get(id);
    this.priority.delete(id);
    return kept && kept.until > this.now() ? kept.queuedAt : undefined;
  }

  /** A pair the queue made: both are busy until it's decided or called off. */
  open(seats: readonly [MatchSeat, MatchSeat]): RankedMatchTicket {
    const ticket = { id: randomUUID(), seats, claimed: false };
    this.matches.set(ticket.id, ticket);
    for (const seat of seats) { this.playing.set(seat.ratingId, ticket.id); }
    return ticket;
  }

  /** The match room for `id` is being made. Only once: a second room, or a made-up id, gets nothing. */
  claim(id: unknown): RankedMatchTicket | undefined {
    const ticket = typeof id === "string" ? this.matches.get(id) : undefined;
    if (!ticket || ticket.claimed) { return undefined; }
    ticket.claimed = true;
    return ticket;
  }

  /** Not yet decided or called off. */
  isOpen(id: string): boolean {
    return this.matches.has(id);
  }

  /** Called off with nobody at fault (couldn't be seated, server closing): no penalty, no rating change. */
  cancel(id: string) {
    this.close(id);
  }

  /**
   * Called off because `dodgerIds` didn't join in time or left before it
   * started: each is locked out of the queue, for longer each time. The other
   * keeps their place in the queue for a while.
   */
  dodged(id: string, dodgerIds: readonly string[]) {
    const ticket = this.close(id);
    if (!ticket) { return; }
    const now = this.now();
    for (const seat of ticket.seats) {
      if (!dodgerIds.includes(seat.ratingId)) {
        this.priority.set(seat.ratingId, { queuedAt: seat.queuedAt, until: now + RANKED.priorityMs });
        continue;
      }
      const record = this.store.get(seat.ratingId) ?? fresh();
      record.dodges = (now - record.lastDodgeAt > RANKED.dodgeMemoryMs ? 0 : record.dodges) + 1;
      record.lastDodgeAt = now;
      const lockouts = RANKED.dodgeLockoutsMs;
      record.bannedUntil = now + lockouts[Math.min(record.dodges, lockouts.length) - 1];
      this.store.set(seat.ratingId, record);
    }
  }

  /**
   * Decided: `winnerId` beat the other. Both are rated on it as one game, each
   * against the other as they stood before it. Returns each one's change, by
   * rating id; nothing if the match was already settled.
   */
  finish(id: string, winnerId: string): Map<string, RatingChange> | undefined {
    const ticket = this.matches.get(id);
    if (!ticket || !ticket.seats.some((seat) => seat.ratingId === winnerId)) { return undefined; }
    this.close(id);

    const now = this.now();
    const [a, b] = ticket.seats.map((seat) => seat.ratingId);
    // Both as they stood before the match: neither is rated against the other's new rating.
    const before = new Map([a, b].map((rid) => [rid, this.store.get(rid) ?? fresh()]));
    const asOpponent = new Map<string, Glicko>([a, b].map((rid) => [rid, this.standing(rid)]));
    const changes = new Map<string, RatingChange>();
    for (const [self, other] of [[a, b], [b, a]]) {
      const record = before.get(self)!;
      const opponent = asOpponent.get(other)!;
      const won = self === winnerId;
      const next = rate(record, [{ opponent, score: won ? 1 : 0 }], {
        tau: RANKED.tau,
        maxDeviation: RANKED.initialDeviation,
        periods: this.periodsSince(record.lastPlayedAt),
      });
      this.store.set(self, {
        ...record, ...next,
        games: record.games + 1,
        wins: record.wins + (won ? 1 : 0),
        lastPlayedAt: now,
      });
      changes.set(self, { before: record.rating, after: next.rating, deviation: next.deviation });
    }
    return changes;
  }

  private close(id: string) {
    const ticket = this.matches.get(id);
    if (!ticket) { return undefined; }
    this.matches.delete(id);
    for (const seat of ticket.seats) {
      if (this.playing.get(seat.ratingId) === id) { this.playing.delete(seat.ratingId); }
    }
    return ticket;
  }

  /** Rating periods since `at`; one for someone who has never played (they're at the cap anyway). */
  private periodsSince(at: number): number {
    return at > 0 ? Math.max(0, this.now() - at) / RANKED.ratingPeriodMs : 1;
  }
}

export const ranked = new Ranked(() => new SqliteRatingStore(database()));
