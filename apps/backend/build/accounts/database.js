import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
/**
 * Where accounts and ratings live. Resolves the same from `src/` (tsx) and
 * `build/` (compiled). In production on Fly it's on the mounted volume
 * (`DB_FILE` in fly.toml): anywhere else in the container is wiped by every
 * deploy.
 */
const DB_FILE = process.env.DB_FILE
    ?? fileURLToPath(new URL("../../data/ligma.db", import.meta.url));
/**
 * The schema, one step per release that changed it; `PRAGMA user_version`
 * records how many have run. Only ever append.
 */
export const MIGRATIONS = [
    `CREATE TABLE accounts (
     id TEXT PRIMARY KEY,
     provider TEXT NOT NULL,
     provider_user_id TEXT NOT NULL,
     name TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     UNIQUE (provider, provider_user_id)
   );
   CREATE TABLE ratings (
     account_id TEXT PRIMARY KEY,
     rating REAL NOT NULL,
     deviation REAL NOT NULL,
     volatility REAL NOT NULL,
     games INTEGER NOT NULL,
     wins INTEGER NOT NULL,
     last_played_at INTEGER NOT NULL,
     dodges INTEGER NOT NULL,
     last_dodge_at INTEGER NOT NULL,
     banned_until INTEGER NOT NULL
   );`,
    // Ranked names are chosen by the player, never taken from the provider (Google's is the
    // person's real full name): forget every name stored so far, and keep names unique.
    `ALTER TABLE accounts ADD COLUMN named INTEGER NOT NULL DEFAULT 0;
   UPDATE accounts SET name = 'Mage-' || substr(replace(id, '-', ''), 1, 10), named = 0;
   CREATE UNIQUE INDEX accounts_name ON accounts (name COLLATE NOCASE);`,
    // When each player last changed their chosen name, for the rename cooldown. 0: never.
    `ALTER TABLE accounts ADD COLUMN renamed_at INTEGER NOT NULL DEFAULT 0;`,
];
/** Opens (creating if needed) the database at `path` — or in memory, for tests — with the schema up to date. */
export function openDatabase(path) {
    if (path !== ":memory:") {
        mkdirSync(dirname(path), { recursive: true });
    }
    const db = new DatabaseSync(path);
    // One writer (this process), quick commits: WAL, and wait rather than fail on a busy file.
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    const { user_version: version } = db.prepare("PRAGMA user_version").get();
    for (let step = version; step < MIGRATIONS.length; step++) {
        db.exec("BEGIN");
        try {
            db.exec(MIGRATIONS[step]);
            db.exec(`PRAGMA user_version = ${step + 1}`);
            db.exec("COMMIT");
        }
        catch (e) {
            db.exec("ROLLBACK");
            throw e;
        }
    }
    return db;
}
let shared;
/** The server's database, opened on first use, so importing this never touches the disk. */
export function database() {
    return shared ??= openDatabase(DB_FILE);
}
