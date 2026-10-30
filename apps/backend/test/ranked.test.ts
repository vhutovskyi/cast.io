import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";
import { CloseCode, type Room as ClientRoom } from "@colyseus/sdk";
import { matchMaker } from "colyseus";

import type appConfig from "../src/app.config.js";
import { testServer } from "./testServer.js";
import type { MyRoomState } from "../src/rooms/schema/MyRoomState.js";
import type { MyRoom } from "../src/rooms/MyRoom.js";
import { MAX_HP } from "../src/shared/constants.js";
import { DUEL } from "../src/shared/gameModes.js";
import { RANKED_QUEUE_MESSAGE, SERVER_MESSAGE } from "../src/shared/messages.js";
import { RANKED, RANKED_CLOSE_CODE, type RankedCancelled, type RankedMatchFound, type RankedQueueStatus, type RankedResult } from "../src/shared/ranked.js";
import { Ranked, ranked } from "../src/ranked/ranked.js";
import { MemoryRatingStore, type RatingRecord } from "../src/ranked/ratingStore.js";
import { accounts, type Account } from "../src/accounts/accounts.js";
import { openDatabase } from "../src/accounts/database.js";
import { ACCOUNT_NAME } from "../src/shared/accounts.js";
import { JWT } from "@colyseus/auth";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const record = (rating: number, extra: Partial<RatingRecord> = {}): RatingRecord => ({
  rating, deviation: 80, volatility: 0.06, games: 10, wins: 5, lastPlayedAt: 0, dodges: 0, lastDodgeAt: 0, bannedUntil: 0, ...extra,
});

/** Resolves with the next `type` message `room` receives. */
function next<T>(room: ClientRoom, type: string): Promise<T> {
  return new Promise((resolve) => {
    const off = room.onMessage(type, (message: T) => { off(); resolve(message); });
  });
}

describe("Ranked", () => {
  describe("the rating service", () => {
    let service: Ranked;
    let now: number;
    const seat = (ratingId: string) => ({ ratingId, name: ratingId, element: "fire" as const, rating: 1500, queuedAt: now });

    beforeEach(() => {
      now = 1_000_000_000;
      service = new Ranked(() => new MemoryRatingStore());
      service.reset(new MemoryRatingStore(), () => now);
    });

    it("rates both players on the result, each against the other as they stood before", () => {
      service.store.set("a", record(1500));
      service.store.set("b", record(1500));
      const match = service.open([seat("a"), seat("b")]);
      const changes = service.finish(match.id, "a");
      const a = service.store.get("a");
      const b = service.store.get("b");
      assert.ok(a.rating > 1500 && b.rating < 1500);
      assert.ok(Math.abs((a.rating - 1500) - (1500 - b.rating)) < 1e-9, "symmetric: neither was rated against the other's new rating");
      assert.deepStrictEqual([a.games, a.wins, b.games, b.wins], [11, 6, 11, 5]);
      assert.strictEqual(a.lastPlayedAt, now);
      assert.deepStrictEqual(changes.get("a"), { before: 1500, after: a.rating, deviation: a.deviation });
      assert.strictEqual(service.finish(match.id, "a"), undefined, "a match is rated once");
    });

    it("refuses to rate a winner who wasn't in the match", () => {
      const match = service.open([seat("a"), seat("b")]);
      assert.strictEqual(service.finish(match.id, "c"), undefined);
      assert.ok(service.isOpen(match.id));
    });

    it("keeps a player out of the queue while they're in a match", () => {
      const match = service.open([seat("a"), seat("b")]);
      assert.match(service.queueRefusal("a"), /already in a ranked match/);
      service.cancel(match.id);
      assert.strictEqual(service.queueRefusal("a"), null);
    });

    it("locks dodgers out for longer each time, and forgives them after a while", () => {
      const dodge = () => service.dodged(service.open([seat("a"), seat("b")]).id, ["a"]);
      dodge();
      assert.strictEqual(service.store.get("a").bannedUntil, now + RANKED.dodgeLockoutsMs[0]);
      assert.match(service.queueRefusal("a"), /queue again in 60s/);
      assert.strictEqual(service.queueRefusal("b"), null, "the one left waiting isn't punished");

      now += RANKED.dodgeLockoutsMs[0];
      assert.strictEqual(service.queueRefusal("a"), null, "the lockout runs out");
      dodge();
      assert.strictEqual(service.store.get("a").bannedUntil, now + RANKED.dodgeLockoutsMs[1], "a second dodge: longer");
      for (let i = 0; i < 5; i++) { dodge(); }
      assert.strictEqual(service.store.get("a").bannedUntil, now + RANKED.dodgeLockoutsMs.at(-1), "the longest repeats");

      now += RANKED.dodgeMemoryMs + 1;
      dodge();
      assert.strictEqual(service.store.get("a").bannedUntil, now + RANKED.dodgeLockoutsMs[0], "forgiven: back to the first lockout");
      assert.strictEqual(service.store.get("a").rating, RANKED.initialRating, "a dodge never changes the rating");
    });

    it("lets whoever a dodger left waiting keep their queue place, once and for a while", () => {
      const queuedAt = now - 30_000;
      service.dodged(service.open([{ ...seat("a"), queuedAt: 1 }, { ...seat("b"), queuedAt }]).id, ["a"]);
      assert.strictEqual(service.takePriority("a"), undefined, "not the dodger");
      assert.strictEqual(service.takePriority("b"), queuedAt);
      assert.strictEqual(service.takePriority("b"), undefined, "used up");

      service.dodged(service.open([seat("a"), { ...seat("b"), queuedAt }]).id, ["a"]);
      now += RANKED.priorityMs + 1;
      assert.strictEqual(service.takePriority("b"), undefined, "expired");
    });

    it("hands each match's room out once, and only for a match it made", () => {
      const match = service.open([seat("a"), seat("b")]);
      assert.strictEqual(service.claim("made up"), undefined);
      assert.strictEqual(service.claim(match.id), match);
      assert.strictEqual(service.claim(match.id), undefined);
    });

    it("grows an idle player's deviation", () => {
      service.store.set("a", record(1600, { deviation: 50, lastPlayedAt: now }));
      assert.strictEqual(service.standing("a").deviation, 50);
      now += 100 * RANKED.ratingPeriodMs;
      assert.ok(service.standing("a").deviation > 50);
      assert.strictEqual(service.store.get("a").deviation, 50, "only shown, not saved");
    });
  });

  describe("queue and match rooms", () => {
    let colyseus: ColyseusTestServer<typeof appConfig>;
    let store: MemoryRatingStore;
    let now: number;

    /** Signed-in players 1–3, each with a session token. */
    let players: Account[];
    let tokens: string[];

    before(async () => {
      colyseus = await testServer();
      JWT.settings.secret = "test-secret";
    });

    beforeEach(async () => {
      await colyseus.cleanup();
      now = 1_000_000_000;
      store = new MemoryRatingStore();
      ranked.reset(store, () => now);
      accounts.reset(openDatabase(":memory:"), () => now);
      players = ["Zed", "Ann", "Bob", "Cat"].map((name, n) => accounts.rename(accounts.signIn("discord", `discord-user-${n}`).id, name) as Account);
      tokens = await Promise.all(players.map((player) => accounts.issueToken(player)));
    });

    afterEach(() => {
      colyseus.sdk.auth.token = undefined;
    });

    const idOf = (n: number) => players[n].id;

    /**
     * What the lobby's Ranked button does, signed in as player `n` (the SDK
     * sends the session with the request) — plus a made-up nickname, as a
     * modified client might send, which must never show.
     */
    const search = (n: number, extra: Record<string, unknown> = {}) => {
      colyseus.sdk.auth.token = tokens[n];
      return colyseus.sdk.joinOrCreate("ranked_queue", { nickname: "Impostor", element: "fire", ...extra } as any);
    };

    /** The server side of a match room. */
    const serverRoom = (roomId: string) => colyseus.getRoomById(roomId) as unknown as MyRoom & {
      state: MyRoomState; locked: boolean; waitForNextTimestep(): Promise<void>;
    };

    /** Both search, get paired on the next queue tick, and join their match. */
    async function matched(ratings: [number, number] = [1500, 1500]) {
      store.set(idOf(1), record(ratings[0]));
      store.set(idOf(2), record(ratings[1]));
      const qa = await search(1);
      const qb = await search(2);
      const [fa, fb] = await Promise.all([next<RankedMatchFound>(qa, RANKED_QUEUE_MESSAGE.matchFound), next<RankedMatchFound>(qb, RANKED_QUEUE_MESSAGE.matchFound)]);
      await Promise.all([qa.leave(), qb.leave()]);
      const a = await colyseus.sdk.consumeSeatReservation<MyRoomState>(fa.reservation as any);
      const b = await colyseus.sdk.consumeSeatReservation<MyRoomState>(fb.reservation as any);
      const room = serverRoom(a.roomId);
      await room.waitForNextTimestep();
      return { a, b, fa, fb, room };
    }

    /** Ends the round-over pause on the next step instead of waiting it out. */
    const skipPhase = async (room: ReturnType<typeof serverRoom>) => {
      (room as unknown as { mode: { phaseEndsAt: number } }).mode.phaseEndsAt = 0;
      await room.waitForNextTimestep();
    };

    it("pairs two searching players into a locked, unlisted ranked duel that starts on its own", async () => {
      const { a, b, fa, fb, room } = await matched([1500, 1560]);
      assert.deepStrictEqual(fa.opponent, { name: "Bob", rating: 1560 });
      assert.deepStrictEqual(fb.opponent, { name: "Ann", rating: 1500 });
      assert.strictEqual(a.roomId, b.roomId);
      assert.strictEqual(room.state.match.ranked, true);
      assert.strictEqual(room.state.match.mode, "duel");
      assert.strictEqual(room.state.match.roundsToWin, DUEL.roundsToWin.default);
      assert.strictEqual(room.state.match.phase, "fighting", "no Ready");
      assert.ok(room.locked, "locked");
      assert.strictEqual((await matchMaker.query({ name: "my_room", private: false })).length, 0, "unlisted");
      assert.strictEqual(room.state.players.get(a.sessionId).name, "Ann", "named by their account");
      assert.strictEqual(room.state.players.get(b.sessionId).name, "Bob");
      assert.ok(![...room.state.players.values()].some((p) => p.name === "Impostor"), "never by the nickname sent");
      assert.strictEqual(room.state.players.get(b.sessionId).element, "fire");
      assert.match(ranked.queueRefusal(idOf(1)), /already in a ranked match/);
    });

    it("shows the account's current name, never one the client sends", async () => {
      // Renamed since signing in: the new name shows from the next match on.
      now += ACCOUNT_NAME.renameCooldownMs;
      assert.strictEqual((accounts.rename(idOf(1), "Ann Renamed") as Account).name, "Ann Renamed");
      const { fa, fb } = await matched();
      assert.strictEqual(fb.opponent.name, "Ann Renamed", "what the opponent is told");
      assert.strictEqual(fa.opponent.name, "Bob");
    });

    it("tells a searching player where they stand, and widens their window as they wait", async () => {
      store.set(idOf(1), record(1712, { deviation: 64, lastPlayedAt: now }));
      const q = await search(1);
      const first = await next<RankedQueueStatus>(q, RANKED_QUEUE_MESSAGE.status);
      assert.deepStrictEqual(first, { rating: 1712, deviation: 64, waitedMs: 0, window: RANKED.window.baseRating, searching: 1 });
      now += 10_000;
      const later = await next<RankedQueueStatus>(q, RANKED_QUEUE_MESSAGE.status);
      assert.strictEqual(later.waitedMs, 10_000);
      assert.strictEqual(later.window, RANKED.window.baseRating + 10 * RANKED.window.perSecond);
    });

    it("keeps far-apart ratings searching until their windows meet", async () => {
      store.set(idOf(1), record(1500));
      store.set(idOf(2), record(1800));
      const qa = await search(1);
      const qb = await search(2);
      let found = false;
      qa.onMessage(RANKED_QUEUE_MESSAGE.matchFound, () => found = true);
      await next(qa, RANKED_QUEUE_MESSAGE.status);
      await next(qa, RANKED_QUEUE_MESSAGE.status);
      assert.strictEqual(found, false, "300 apart: not yet");
      now += 20_000;
      const match = await next<RankedMatchFound>(qa, RANKED_QUEUE_MESSAGE.matchFound);
      assert.strictEqual(match.opponent.name, "Bob");
      await qb.leave();
    });

    it("refuses anyone not signed in: no session, a forged one, or one whose account is gone", async () => {
      colyseus.sdk.auth.token = undefined;
      await assert.rejects(colyseus.sdk.joinOrCreate("ranked_queue", {} as any), /Sign in to play ranked/);
      colyseus.sdk.auth.token = "not a token";
      await assert.rejects(colyseus.sdk.joinOrCreate("ranked_queue", {} as any), /Sign in to play ranked/);

      JWT.settings.secret = "someone else's secret";
      const forged = await accounts.issueToken(players[1]);
      JWT.settings.secret = "test-secret";
      colyseus.sdk.auth.token = forged;
      await assert.rejects(colyseus.sdk.joinOrCreate("ranked_queue", {} as any), /Sign in to play ranked/);

      colyseus.sdk.auth.token = await accounts.issueToken({ id: "deleted" });
      await assert.rejects(colyseus.sdk.joinOrCreate("ranked_queue", {} as any), /Sign in to play ranked/);
    });

    it("refuses a second search by the same player, and a player still in a match", async () => {
      const q = await search(1);
      await assert.rejects(search(1), /already searching/);
      await q.leave();

      await matched();
      await assert.rejects(search(1), /already in a ranked match/);
    });

    it("rates the winner up and the loser down when the match is won on rounds", async () => {
      const { a, b, room } = await matched();
      const results = [next<RankedResult>(a, SERVER_MESSAGE.rankedResult), next<RankedResult>(b, SERVER_MESSAGE.rankedResult)];
      for (let round = 1; round <= DUEL.roundsToWin.default; round++) {
        room.damage(b.sessionId, MAX_HP);
        await room.waitForNextTimestep();
        await skipPhase(room);
      }
      const [ra, rb] = await Promise.all(results);
      assert.strictEqual(room.state.match.matchWinnerId, a.sessionId);
      assert.deepStrictEqual([ra.won, ra.forfeit, rb.won, rb.forfeit], [true, false, false, false]);
      assert.strictEqual(ra.ratingBefore, 1500);
      assert.ok(ra.ratingAfter > 1500 && rb.ratingAfter < 1500);
      assert.strictEqual(store.get(idOf(1)).rating, ra.ratingAfter, "saved");
      assert.strictEqual(store.get(idOf(2)).rating, rb.ratingAfter);
      assert.strictEqual(ranked.queueRefusal(idOf(1)), null, "free to search again");

      await skipPhase(room);
      assert.strictEqual(room.state.match.phase, "waiting", "one match only: no rematch");
    });

    it("leaving mid-match forfeits it, rated as a loss", async () => {
      const { a, b, room } = await matched();
      const result = next<RankedResult>(a, SERVER_MESSAGE.rankedResult);
      await b.leave();
      const ra = await result;
      assert.deepStrictEqual([ra.won, ra.forfeit], [true, true]);
      assert.strictEqual(room.state.match.matchWinnerId, a.sessionId);
      assert.ok(store.get(idOf(2)).rating < 1500, "the leaver lost rating");
      assert.strictEqual(store.get(idOf(2)).bannedUntil, 0, "a forfeit isn't a dodge");
    });

    it("holds a dropped player's seat with the fight paused, and resumes once they're back", async () => {
      const { b, room } = await matched();
      b.reconnection.minUptime = 0;
      const back = new Promise<void>((resolve) => b.onReconnect(() => resolve()));
      b.connection.close(CloseCode.MAY_TRY_RECONNECT);
      await sleep(50);
      await room.waitForNextTimestep();

      assert.strictEqual(room.state.match.awaitingId, b.sessionId);
      assert.strictEqual(room.state.match.awaitingSeconds, RANKED.disconnectBudgetMs / 1000);
      room.damage(b.sessionId, 10);
      assert.strictEqual(room.state.players.get(b.sessionId).hp, MAX_HP, "paused: hits don't count");

      await back;
      await room.waitForNextTimestep();
      assert.strictEqual(room.state.match.awaitingId, "");
      room.damage(b.sessionId, 10);
      assert.strictEqual(room.state.players.get(b.sessionId).hp, MAX_HP - 10, "back on");
      assert.ok(ranked.isOpen((room as unknown as { ranked: { ticket: { id: string } } }).ranked.ticket.id), "still the same match");
    });

    it("a drop with no disconnect time left forfeits the match", async () => {
      const { a, b, room } = await matched();
      const match = (room as unknown as { ranked: { disconnectedMs: Map<string, number> } }).ranked;
      match.disconnectedMs.set(idOf(2), RANKED.disconnectBudgetMs);
      const result = next<RankedResult>(a, SERVER_MESSAGE.rankedResult);
      b.reconnection.enabled = false;
      b.connection.close(CloseCode.MAY_TRY_RECONNECT);
      const ra = await result;
      assert.deepStrictEqual([ra.won, ra.forfeit], [true, true]);
      assert.ok(store.get(idOf(2)).rating < 1500);
    });

    /** The server's ranked match in a room, for what the tests reach into. */
    const rankedOf = (room: ReturnType<typeof serverRoom>) =>
      (room as unknown as { ranked: { ticket: { id: string }; disconnectedMs: Map<string, number> } }).ranked;

    /** Gives player `n` only `ms` of disconnect time left this match. */
    const leaveOnly = (room: ReturnType<typeof serverRoom>, n: number, ms: number) =>
      rankedOf(room).disconnectedMs.set(idOf(n), RANKED.disconnectBudgetMs - ms);

    it("leaving once both are in, before the first round has begun, forfeits — it's no free dodge", async () => {
      store.set(idOf(1), record(1500));
      store.set(idOf(2), record(1500));
      const qa = await search(1);
      const qb = await search(2);
      const [fa, fb] = await Promise.all([next<RankedMatchFound>(qa, RANKED_QUEUE_MESSAGE.matchFound), next<RankedMatchFound>(qb, RANKED_QUEUE_MESSAGE.matchFound)]);
      await Promise.all([qa.leave(), qb.leave()]);
      const a = await colyseus.sdk.consumeSeatReservation<MyRoomState>(fa.reservation as any);
      const room = serverRoom(a.roomId);
      // Hold the duel's start, so Bob can leave in the moment between joining and the first round.
      (room as unknown as { mode: { phaseEndsAt: number } }).mode.phaseEndsAt = Infinity;
      const b = await colyseus.sdk.consumeSeatReservation<MyRoomState>(fb.reservation as any);
      await room.waitForNextTimestep();
      assert.deepStrictEqual([room.state.match.phase, room.state.match.round || 0], ["waiting", 0], "both in, no round yet");

      const result = next<RankedResult>(a, SERVER_MESSAGE.rankedResult);
      await b.leave();
      const ra = await result;
      assert.deepStrictEqual([ra.won, ra.forfeit], [true, true]);
      assert.strictEqual(room.state.match.matchWinnerId, a.sessionId);
      assert.ok(store.get(idOf(2)).rating < 1500, "rated as Bob's loss");
      assert.strictEqual(store.get(idOf(2)).games, 11);
      assert.ok(!ranked.isOpen(rankedOf(room).ticket.id));
    });

    it("both disconnected: whoever runs out of time first doesn't hand the win to the other — coming back does", async () => {
      const { a, b, room } = await matched();
      const ticket = rankedOf(room).ticket.id;
      leaveOnly(room, 1, 1500); // Ann: a second of disconnect time left
      a.reconnection.enabled = false;
      b.reconnection.enabled = false;
      const bobsToken = b.reconnectionToken;
      b.connection.close(CloseCode.MAY_TRY_RECONNECT);
      await sleep(50);
      a.connection.close(CloseCode.MAY_TRY_RECONNECT);

      await sleep(1600);
      assert.ok(ranked.isOpen(ticket), "Ann has run out of time, but Bob is away too: nothing decided yet");
      assert.strictEqual(room.state.match.matchWinnerId, "");

      const bob = await colyseus.sdk.reconnect<MyRoomState>(bobsToken);
      await sleep(100);
      assert.strictEqual(room.state.match.matchWinnerId, b.sessionId, "Bob came back: Bob wins");
      assert.ok(!ranked.isOpen(ticket));
      assert.ok(store.get(idOf(2)).rating > 1500 && store.get(idOf(1)).rating < 1500);
      await bob.leave();
    });

    it("both disconnected and neither comes back: void, nobody's rating moves", async () => {
      const { a, b, room } = await matched();
      const ticket = rankedOf(room).ticket.id;
      leaveOnly(room, 1, 1500); // Ann out of time after 1 s,
      leaveOnly(room, 2, 2500); // Bob after 2 s: the last to time out
      a.reconnection.enabled = false;
      b.reconnection.enabled = false;
      a.connection.close(CloseCode.MAY_TRY_RECONNECT);
      b.connection.close(CloseCode.MAY_TRY_RECONNECT);

      await sleep(2800);
      assert.ok(!ranked.isOpen(ticket), "settled");
      for (const n of [1, 2]) {
        assert.deepStrictEqual([store.get(idOf(n)).rating, store.get(idOf(n)).games, store.get(idOf(n)).bannedUntil], [1500, 10, 0], `player ${n} untouched`);
        assert.strictEqual(ranked.queueRefusal(idOf(n)), null, `player ${n} can search again`);
      }
    });

    it("a matched player who never joins has dodged: called off, locked out, and the other keeps their place", async () => {
      store.set(idOf(1), record(1500));
      store.set(idOf(2), record(1500));
      const qa = await search(1);
      const qb = await search(2);
      const [fa, fb] = await Promise.all([next<RankedMatchFound>(qa, RANKED_QUEUE_MESSAGE.matchFound), next<RankedMatchFound>(qb, RANKED_QUEUE_MESSAGE.matchFound)]);
      await Promise.all([qa.leave(), qb.leave()]);
      const queuedAt = now;
      const a = await colyseus.sdk.consumeSeatReservation<MyRoomState>(fa.reservation as any);
      const room = serverRoom(a.roomId);
      await room.waitForNextTimestep();
      assert.strictEqual(room.state.match.phase, "waiting", "Bob never comes");

      // Fully joined (the server holds messages until the client confirms), so the message gets there too.
      await sleep(100);
      const cancelled = next<RankedCancelled>(a, SERVER_MESSAGE.rankedCancelled);
      const left = new Promise<number>((resolve) => a.onLeave((code) => resolve(code)));
      // The join deadline, without waiting it out.
      (room as unknown as { ranked: { noShow(): void } }).ranked.noShow();
      assert.deepStrictEqual(await cancelled, { reason: "opponentDodged" });
      assert.strictEqual(await left, RANKED_CLOSE_CODE.calledOff, "the close code says it, message or not");

      await assert.rejects(colyseus.sdk.consumeSeatReservation(fb.reservation as any), /called off/, "too late");
      assert.ok(store.get(idOf(2)).bannedUntil > now, "Bob is locked out");
      await assert.rejects(search(2), /dodged a ranked match/);
      // A fresh browser: storage cleared, signed in again — the same account, still locked out.
      const signedInAgain = accounts.signIn("discord", "discord-user-2");
      assert.strictEqual(signedInAgain.id, idOf(2));
      tokens[2] = await accounts.issueToken(signedInAgain);
      await assert.rejects(search(2), /dodged a ranked match/, "the lockout follows the account");
      assert.strictEqual(store.get(idOf(1)).rating, 1500, "nobody's rating moved");
      assert.strictEqual(store.get(idOf(2)).rating, 1500);

      now += 5_000;
      const again = await search(1);
      const status = await next<RankedQueueStatus>(again, RANKED_QUEUE_MESSAGE.status);
      assert.strictEqual(status.waitedMs, now - queuedAt, "Ann is back where she was in the queue");
    });

    it("leaving before the opponent arrives is a dodge, and their seat is gone", async () => {
      store.set(idOf(1), record(1500));
      store.set(idOf(2), record(1500));
      const qa = await search(1);
      const qb = await search(2);
      const [fa, fb] = await Promise.all([next<RankedMatchFound>(qa, RANKED_QUEUE_MESSAGE.matchFound), next<RankedMatchFound>(qb, RANKED_QUEUE_MESSAGE.matchFound)]);
      await Promise.all([qa.leave(), qb.leave()]);
      const a = await colyseus.sdk.consumeSeatReservation(fa.reservation as any);
      await a.leave();
      await sleep(50);
      await assert.rejects(colyseus.sdk.consumeSeatReservation(fb.reservation as any));
      assert.ok(store.get(idOf(1)).bannedUntil > now, "Ann dodged");
      assert.strictEqual(store.get(idOf(2)).bannedUntil, 0);
      assert.strictEqual(ranked.queueRefusal(idOf(2)), null, "Bob can search again straight away");
    });

    it("stopping the search while the match is being made calls it off, and the other searches on", async () => {
      store.set(idOf(1), record(1500));
      store.set(idOf(2), record(1500));
      const qa = await search(1);
      const qb = await search(2);
      // Bob leaves the instant the pair is made, gone by the time the room is ready.
      const queue = colyseus.getRoomById(qa.roomId) as unknown as { startMatch(a: unknown, b: unknown): Promise<void> };
      const start = queue.startMatch.bind(queue);
      queue.startMatch = async (x, y) => { await qb.leave(); await sleep(50); await start(x, y); };
      let found = false;
      qa.onMessage(RANKED_QUEUE_MESSAGE.matchFound, () => found = true);
      await next(qa, RANKED_QUEUE_MESSAGE.status);
      await next(qa, RANKED_QUEUE_MESSAGE.status);
      assert.strictEqual(found, false);
      assert.strictEqual(store.get(idOf(2)).bannedUntil, 0, "not a dodge");
      assert.strictEqual(ranked.queueRefusal(idOf(1)), null);
      await qa.leave();
    });

    /** Resolves once `room` is left, or rejects after `ms`. */
    const leftWithin = (room: ClientRoom, ms: number) => new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`still in the room after ${ms} ms`)), ms);
      room.onLeave((code) => { clearTimeout(timer); resolve(code); });
    });

    it("a deploy waits for a match under way: it's played out and counts, then the room closes", async () => {
      const { a, b, room } = await matched();
      room.onBeforeShutdown();
      await room.waitForNextTimestep();
      assert.strictEqual(room.clients.length, 2, "nobody sent away");

      const results = [next<RankedResult>(a, SERVER_MESSAGE.rankedResult), next<RankedResult>(b, SERVER_MESSAGE.rankedResult)];
      for (let round = 1; round <= DUEL.roundsToWin.default; round++) {
        room.damage(b.sessionId, MAX_HP);
        await room.waitForNextTimestep();
        await skipPhase(room);
      }
      const [ra] = await Promise.all(results);
      assert.strictEqual(ra.won, true);
      assert.ok(store.get(idOf(1)).rating > 1500 && store.get(idOf(2)).rating < 1500, "rated");
      await leftWithin(a, RANKED.shutdownResultHoldMs + 1000);
    });

    it("a match the deploy can't wait for is voided, and both are told why", async () => {
      const { a, b, room } = await matched();
      room.onBeforeShutdown();
      const told = [next<RankedCancelled>(a, SERVER_MESSAGE.rankedCancelled), next<RankedCancelled>(b, SERVER_MESSAGE.rankedCancelled)];
      // The drain limit running out, without waiting it out.
      (rankedOf(room) as unknown as { abandonForRestart(): void }).abandonForRestart();
      assert.deepStrictEqual(await Promise.all(told), [{ reason: "serverRestart" }, { reason: "serverRestart" }]);
      assert.strictEqual(await leftWithin(a, 1000), CloseCode.SERVER_SHUTDOWN);
      for (const n of [1, 2]) {
        assert.deepStrictEqual([store.get(idOf(n)).rating, store.get(idOf(n)).games, store.get(idOf(n)).bannedUntil], [1500, 10, 0]);
      }
      assert.strictEqual(ranked.queueRefusal(idOf(1)), null);
    });

    it("a deploy calls off a match that hasn't started, at nobody's expense", async () => {
      store.set(idOf(1), record(1500));
      store.set(idOf(2), record(1500));
      const qa = await search(1);
      const qb = await search(2);
      const [fa, fb] = await Promise.all([next<RankedMatchFound>(qa, RANKED_QUEUE_MESSAGE.matchFound), next<RankedMatchFound>(qb, RANKED_QUEUE_MESSAGE.matchFound)]);
      await Promise.all([qa.leave(), qb.leave()]);
      const a = await colyseus.sdk.consumeSeatReservation<MyRoomState>(fa.reservation as any);
      const room = serverRoom(a.roomId);
      await room.waitForNextTimestep();
      const told = next<RankedCancelled>(a, SERVER_MESSAGE.rankedCancelled);
      const left = leftWithin(a, 1000);
      room.onBeforeShutdown();
      assert.deepStrictEqual(await told, { reason: "serverRestart" });
      assert.strictEqual(await left, CloseCode.SERVER_SHUTDOWN, "the close code says it too");
      await assert.rejects(colyseus.sdk.consumeSeatReservation(fb.reservation as any), /called off/, "Bob arriving late");
      assert.strictEqual(store.get(idOf(2)).bannedUntil, 0, "Bob hadn't dodged: the server went");
      assert.strictEqual(ranked.queueRefusal(idOf(2)), null);
    });

    it("a deploy closes every other room straight away", async () => {
      const casual = await colyseus.createRoom<MyRoomState>("my_room", { mode: "duel" });
      const client = await colyseus.connectTo(casual);
      (casual as unknown as MyRoom).onBeforeShutdown();
      await leftWithin(client as unknown as ClientRoom, 1000);
    });

    it("refuses a ranked room nobody queued for, and anyone without a seat in one", async () => {
      await assert.rejects(colyseus.sdk.create("my_room", { ranked: "made-up" } as any), /ranked queue/);
      const { a } = await matched();
      await assert.rejects(colyseus.sdk.joinById(a.roomId, { rankedId: idOf(1) } as any), /locked/);
    });
  });
});
