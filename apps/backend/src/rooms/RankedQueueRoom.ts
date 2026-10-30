import { Room, Client, ServerError, matchMaker } from "colyseus";
import { DEFAULT_ELEMENT, isPlayableElement, type MagicElement } from "../shared/elements.js";
import { RANKED_QUEUE_MESSAGE } from "../shared/messages.js";
import { RANKED, searchWindow, type RankedMatchFound, type RankedQueueOptions, type RankedQueueStatus } from "../shared/ranked.js";
import { ranked, type MatchSeat } from "../ranked/ranked.js";
import { accounts, type Account } from "../accounts/accounts.js";
import { pairQueue, type Searching } from "../ranked/matchmaking.js";
import type { ArenaOptions } from "./MyRoom.js";

/** Someone in the queue. `id` is their rating id. */
interface Entry extends Searching {
  client: Client;
  /** Their account's name: what the opponent and the match show. */
  name: string;
  element: MagicElement;
  deviation: number;
  /** Paired, their match room being made: out of the search. */
  matching: boolean;
}

/**
 * The ranked duel queue: being in this room is searching, leaving it stops.
 * Only for signed-in players: ratings and dodge lockouts belong to the
 * account, so a fresh browser doesn't shake them off.
 * Every `RANKED.tickMs` it pairs whoever it can (`pairQueue`, by rating with a
 * window that widens the longer they wait), makes each pair a match room and
 * hands both their seat in it. Everyone still searching hears how it's going.
 */
export class RankedQueueRoom extends Room {
  /** By session id. */
  private searching = new Map<string, Entry>();

  /** The account behind the sign-in session the SDK sends; anyone else is turned away. */
  static async onAuth(token: string): Promise<Account> {
    const account = await accounts.fromToken(token);
    if (!account) { throw new ServerError(401, "Sign in to play ranked."); }
    return account;
  }

  onCreate() {
    this.clock.setInterval(() => this.tick(), RANKED.tickMs);
  }

  onJoin(client: Client, options: RankedQueueOptions) {
    const account = client.auth as Account | undefined;
    if (!account) { throw new ServerError(401, "Sign in to play ranked."); }
    const { id } = account;
    const element = options?.element ?? DEFAULT_ELEMENT;
    if (!isPlayableElement(element)) { throw new ServerError(400, "That element can't be played yet."); }
    if ([...this.searching.values()].some((entry) => entry.id === id)) {
      throw new ServerError(409, "You're already searching, in another tab.");
    }
    const refusal = ranked.queueRefusal(id);
    if (refusal) { throw new ServerError(403, refusal); }

    const { rating, deviation } = ranked.standing(id);
    const entry: Entry = {
      id, client, element, rating, deviation,
      // Never a name the client sends: ranked players are known by their account.
      name: account.name,
      // Sent back by a dodger: their place in the queue is kept.
      queuedAt: ranked.takePriority(id) ?? ranked.now(),
      matching: false,
    };
    this.searching.set(client.sessionId, entry);
    this.sendStatus(entry, ranked.now());
  }

  onLeave(client: Client) {
    this.searching.delete(client.sessionId);
  }

  private tick() {
    const now = ranked.now();
    const free = [...this.searching.values()].filter((entry) => !entry.matching);
    for (const [a, b] of pairQueue(free, now)) {
      this.startMatch(a, b).catch((e) => console.error("ranked: couldn't start a match:", e));
    }
    for (const entry of this.searching.values()) {
      if (!entry.matching) { this.sendStatus(entry, now); }
    }
  }

  /**
   * Makes `a` and `b` a match room with a seat for each, and sends them to
   * it. If either stops searching meanwhile, or the room can't be made, it's
   * called off with nobody at fault, and whoever is still here searches on.
   */
  private async startMatch(a: Entry, b: Entry) {
    a.matching = b.matching = true;
    const seat = (entry: Entry): MatchSeat => ({
      ratingId: entry.id, name: entry.name, element: entry.element, rating: entry.rating, queuedAt: entry.queuedAt,
    });
    const ticket = ranked.open([seat(a), seat(b)]);
    let roomId: string | undefined;
    try {
      const room = await matchMaker.createRoom("my_room", { ranked: ticket.id } satisfies ArenaOptions);
      roomId = room.roomId;
      const reservations = await Promise.all([a, b].map((entry) =>
        matchMaker.reserveSeatFor(room, { rankedId: entry.id } satisfies ArenaOptions)));
      if (this.searching.get(a.client.sessionId) !== a || this.searching.get(b.client.sessionId) !== b) {
        throw new Error("left the queue while their match was being made");
      }
      for (const [entry, opponent, reservation] of [[a, b, reservations[0]], [b, a, reservations[1]]] as const) {
        this.searching.delete(entry.client.sessionId);
        entry.client.send(RANKED_QUEUE_MESSAGE.matchFound, {
          reservation,
          opponent: { name: opponent.name, rating: Math.round(opponent.rating) },
        } satisfies RankedMatchFound);
      }
    } catch (e) {
      ranked.cancel(ticket.id);
      if (roomId) { matchMaker.getLocalRoomById(roomId)?.disconnect().catch(() => {}); }
      a.matching = b.matching = false;
      if (!(e instanceof Error && e.message.startsWith("left the queue"))) { throw e; }
    }
  }

  private sendStatus(entry: Entry, now: number) {
    const waitedMs = Math.max(0, now - entry.queuedAt);
    entry.client.send(RANKED_QUEUE_MESSAGE.status, {
      rating: Math.round(entry.rating),
      deviation: Math.round(entry.deviation),
      waitedMs,
      window: Math.round(searchWindow(waitedMs)),
      searching: this.searching.size,
    } satisfies RankedQueueStatus);
  }
}
