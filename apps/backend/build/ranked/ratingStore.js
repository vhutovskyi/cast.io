/** Forgotten with the process: for tests. */
export class MemoryRatingStore {
    constructor() {
        this.records = new Map();
    }
    get(id) {
        const record = this.records.get(id);
        return record && { ...record };
    }
    set(id, record) {
        this.records.set(id, { ...record });
    }
}
/** Every column, as `RatingRecord` names it. */
const COLUMNS = `rating, deviation, volatility, games, wins,
  last_played_at AS lastPlayedAt, dodges, last_dodge_at AS lastDodgeAt, banned_until AS bannedUntil`;
/** In the server's database, by account id: survives restarts and deploys (on the Fly volume). */
export class SqliteRatingStore {
    constructor(db) {
        this.db = db;
    }
    get(id) {
        const row = this.db.prepare(`SELECT ${COLUMNS} FROM ratings WHERE account_id = ?`).get(id);
        return row ? { ...row } : undefined;
    }
    set(id, r) {
        this.db.prepare(`INSERT INTO ratings (account_id, rating, deviation, volatility, games, wins, last_played_at, dodges, last_dodge_at, banned_until)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (account_id) DO UPDATE SET rating = excluded.rating, deviation = excluded.deviation, volatility = excluded.volatility,
        games = excluded.games, wins = excluded.wins, last_played_at = excluded.last_played_at, dodges = excluded.dodges,
        last_dodge_at = excluded.last_dodge_at, banned_until = excluded.banned_until`)
            .run(id, r.rating, r.deviation, r.volatility, r.games, r.wins, r.lastPlayedAt, r.dodges, r.lastDodgeAt, r.bannedUntil);
    }
}
