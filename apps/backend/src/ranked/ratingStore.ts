import type { DatabaseSync } from "node:sqlite";

/** Everything kept about one ranked player, by account id. */
export interface RatingRecord {
  rating: number;
  deviation: number;
  volatility: number;
  games: number;
  wins: number;
  /** Wall-clock ms of their last rated match; 0 = never. */
  lastPlayedAt: number;
  /** Dodges since the last one forgiven (`RANKED.dodgeMemoryMs`). */
  dodges: number;
  lastDodgeAt: number;
  /** Wall-clock ms they may queue again from. */
  bannedUntil: number;
}

export interface RatingStore {
  get(id: string): RatingRecord | undefined;
  set(id: string, record: RatingRecord): void;
}

/** Forgotten with the process: for tests. */
export class MemoryRatingStore implements RatingStore {
  private readonly records = new Map<string, RatingRecord>();

  get(id: string) {
    const record = this.records.get(id);
    return record && { ...record };
  }

  set(id: string, record: RatingRecord) {
    this.records.set(id, { ...record });
  }
}

/** Every column, as `RatingRecord` names it. */
const COLUMNS = `rating, deviation, volatility, games, wins,
  last_played_at AS lastPlayedAt, dodges, last_dodge_at AS lastDodgeAt, banned_until AS bannedUntil`;

/** In the server's database, by account id: survives restarts and deploys (on the Fly volume). */
export class SqliteRatingStore implements RatingStore {
  constructor(private readonly db: DatabaseSync) {}

  get(id: string): RatingRecord | undefined {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM ratings WHERE account_id = ?`).get(id);
    return row ? { ...row } as unknown as RatingRecord : undefined;
  }

  set(id: string, r: RatingRecord) {
    this.db.prepare(`INSERT INTO ratings (account_id, rating, deviation, volatility, games, wins, last_played_at, dodges, last_dodge_at, banned_until)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (account_id) DO UPDATE SET rating = excluded.rating, deviation = excluded.deviation, volatility = excluded.volatility,
        games = excluded.games, wins = excluded.wins, last_played_at = excluded.last_played_at, dodges = excluded.dodges,
        last_dodge_at = excluded.last_dodge_at, banned_until = excluded.banned_until`)
      .run(id, r.rating, r.deviation, r.volatility, r.games, r.wins, r.lastPlayedAt, r.dodges, r.lastDodgeAt, r.bannedUntil);
  }
}
