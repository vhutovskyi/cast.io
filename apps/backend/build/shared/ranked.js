export const RANKED = {
    /** Where every new player starts (Glicko-2's defaults). */
    initialRating: 1500,
    initialDeviation: 350,
    initialVolatility: 0.06,
    /** Glicko-2's τ: how far a surprising result may move volatility. 0.3–1.2; lower is steadier. */
    tau: 0.5,
    /** A Glicko-2 rating period: a player's deviation grows by one period's worth of volatility per this long away. */
    ratingPeriodMs: 24 * 60 * 60 * 1000,
    /** Above this deviation the rating is still a guess: shown with a "?". */
    provisionalDeviation: 110,
    /**
     * The search window, in rating points either side: `baseRating` at first,
     * widening by `perSecond` for every second waited, up to `maxRating`. Two
     * players are paired once each is inside the other's window.
     */
    window: { baseRating: 100, perSecond: 10, maxRating: 800 },
    /** How often the queue looks for pairs and tells everyone where they stand. */
    tickMs: 1000,
    /** Both matched players must join the match room within this long; whoever doesn't has dodged. */
    joinTimeoutMs: 15_000,
    /**
     * Total time a player may spend disconnected over one match: the fight is
     * paused meanwhile. Once it's spent, a drop forfeits the match.
     */
    disconnectBudgetMs: 60_000,
    /** After the result, the room stays open this long so both can read it. */
    resultHoldMs: 60_000,
    /**
     * A deploy waits this long at most for a match under way to finish, then
     * voids it. Under fly.toml's `kill_timeout` (300 s, best-effort), with room
     * to spare. The machine is replaced, not doubled, so the game is down for
     * everyone else meanwhile.
     */
    shutdownDrainMs: 240_000,
    /** While a deploy waits, the result stays up only this long. */
    shutdownResultHoldMs: 5_000,
    /** Queue lockout after a dodge: the first, second, … within `dodgeMemoryMs` of the last. The last repeats. */
    dodgeLockoutsMs: [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000],
    /** A dodge is forgiven once this long has passed without another. */
    dodgeMemoryMs: 24 * 60 * 60 * 1000,
    /** Whoever was left waiting by a dodger keeps their place in the queue if they re-queue within this long. */
    priorityMs: 2 * 60_000,
};
/** The rating window, either side, of a player who has waited `waitedMs`. */
export function searchWindow(waitedMs) {
    const { baseRating, perSecond, maxRating } = RANKED.window;
    return Math.min(maxRating, baseRating + perSecond * Math.max(0, waitedMs) / 1000);
}
/** Whether a rating with this deviation is still a guess. */
export function isProvisional(deviation) {
    return deviation > RANKED.provisionalDeviation;
}
/**
 * How a match room closes when its match is called off — the reliable signal,
 * since a message sent just before closing is lost if the player had only
 * just joined. A server restart closes with Colyseus' `SERVER_SHUTDOWN` (4001).
 */
export const RANKED_CLOSE_CODE = {
    /** Called off before it started: the opponent dodged. */
    calledOff: 4100,
};
