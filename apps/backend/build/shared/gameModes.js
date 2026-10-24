/**
 * Game modes: the rules of a room — seats, death, rounds, scoring — and the
 * settings its creator may pick. Shared code: the backend enforces them, the
 * lobby offers them.
 */
/** Every mode, in picker order. */
export const GAME_MODES = ["ffa", "duel", "battleRoyale"];
export const DEFAULT_GAME_MODE = "ffa";
export function isGameMode(value) {
    return GAME_MODES.includes(value);
}
export const FFA = {
    maxPlayers: { default: 8, min: 2, max: 16 },
};
export const DUEL = {
    maxClients: 2,
    roundsToWin: { default: 3, min: 1, max: 9 },
    /** The round's result stays up this long before the next round (or the match result). */
    roundOverMs: 2500,
    /** Distance of each duel spawn from the arena centre, across from each other. */
    spawnOffset: 220,
};
export const BATTLE_ROYALE = {
    maxPlayers: { default: 6, min: 3, max: 16 },
    roundsToWin: { default: 3, min: 1, max: 9 },
    /** Fewest players, all ready, for a match to start. */
    minPlayers: 2,
    /** The round's result stays up this long before the next round (or the match result). */
    roundOverMs: 2500,
    /** Radius of the spawn ring around the arena centre: one evenly spaced spawn per seat. */
    spawnRadius: 220,
};
/**
 * Quick Play rooms: found by the matchmaker, run on each mode's default
 * settings, and have no Ready button — a duel or battle royale match starts
 * as soon as enough players are seated (`DUEL.maxClients`,
 * `BATTLE_ROYALE.minPlayers`).
 */
export const QUICK_PLAY = {
    /** After a match its result stays up this long; then the next one starts on its own, if enough are still seated. */
    matchOverMs: 4000,
};
/** Seats in a room running `config`. */
export function maxClientsOf(config) {
    return config.mode === "duel" ? DUEL.maxClients : config.settings.maxPlayers;
}
/** A whole number within [min, max]; anything else falls back to the default. */
function clampInt(raw, { default: fallback, min, max }) {
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, Math.round(raw)));
}
/**
 * The room creator's choice, validated: settings are clamped to the mode's
 * limits, unknown fields dropped. Null for a mode that doesn't exist.
 * Never trust the wire — this is also what the lobby lists.
 */
export function parseGameMode(mode, settings) {
    const raw = (typeof settings === "object" && settings !== null ? settings : {});
    switch (mode ?? DEFAULT_GAME_MODE) {
        case "ffa":
            return { mode: "ffa", settings: { maxPlayers: clampInt(raw.maxPlayers, FFA.maxPlayers) } };
        case "duel":
            return { mode: "duel", settings: { roundsToWin: clampInt(raw.roundsToWin, DUEL.roundsToWin) } };
        case "battleRoyale":
            return {
                mode: "battleRoyale",
                settings: {
                    maxPlayers: clampInt(raw.maxPlayers, BATTLE_ROYALE.maxPlayers),
                    roundsToWin: clampInt(raw.roundsToWin, BATTLE_ROYALE.roundsToWin),
                },
            };
        default:
            return null;
    }
}
