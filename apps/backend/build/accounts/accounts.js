import { randomInt, randomUUID } from "node:crypto";
import { JWT } from "@colyseus/auth";
import { ACCOUNT_NAME } from "../shared/accounts.js";
import { database } from "./database.js";
/** Whether session tokens can be signed and checked at all: without a secret, nobody can sign in. */
export function hasSessionSecret() {
    return Boolean(JWT.settings.secret || process.env.JWT_SECRET);
}
/** A session lasts this long; signing in again starts a new one. */
const SESSION_LENGTH = "90d";
/** Printable characters only, whitespace collapsed, capped: names are player-chosen and shown to others. */
const cleanName = (raw) => typeof raw === "string" ? raw.replace(/\s+/g, " ").replace(/\p{C}/gu, "").trim().slice(0, ACCOUNT_NAME.maxLength) : "";
/** A made-up name for a new account, until they choose one. */
const placeholderName = () => `Mage-${randomInt(1_000_000).toString().padStart(6, "0")}`;
const isUniqueViolation = (e) => e instanceof Error && /UNIQUE constraint failed: accounts\.name/.test(e.message);
const COLUMNS = "id, name, named, renamed_at AS renamedAt, provider";
const fromRow = (row) => ({
    id: row.id,
    name: row.name,
    named: row.named === 1,
    renameAvailableAt: row.renamedAt > 0 ? row.renamedAt + ACCOUNT_NAME.renameCooldownMs : 0,
    provider: row.provider,
});
/**
 * Accounts, one per provider identity: signing in again with the same
 * Discord or Google account is always the same account, whatever the browser
 * remembers. Session tokens are JWTs (`JWT_SECRET`).
 */
export class Accounts {
    constructor(open = database, now = Date.now) {
        this.open = open;
        this.now = now;
    }
    /** Tests: start over on `db`, at the time `now` says. */
    reset(db, now = Date.now) {
        this.db = db;
        this.now = now;
    }
    get sql() {
        return this.db ??= this.open();
    }
    /** The account for this provider identity, made on first sign-in with a made-up name. */
    signIn(provider, providerUserId) {
        const existing = this.sql.prepare(`SELECT ${COLUMNS} FROM accounts WHERE provider = ? AND provider_user_id = ?`)
            .get(provider, providerUserId);
        if (existing) {
            return fromRow(existing);
        }
        const id = randomUUID();
        for (;;) {
            const name = placeholderName();
            try {
                this.sql.prepare("INSERT INTO accounts (id, provider, provider_user_id, name, named, created_at) VALUES (?, ?, ?, ?, 0, ?)")
                    .run(id, provider, providerUserId, name, this.now());
                return { id, name, named: false, renameAvailableAt: 0, provider };
            }
            catch (e) {
                // That made-up name is someone's already: make up another.
                if (!isUniqueViolation(e)) {
                    throw e;
                }
            }
        }
    }
    /**
     * Gives `id` the ranked name `raw`, cleaned up: the account, or why not.
     * Their first choice is never blocked; every change, that one included,
     * starts the cooldown before the next. A refusal, or saving the name they
     * already have, spends nothing.
     */
    rename(id, raw) {
        const current = this.find(id);
        const name = cleanName(raw);
        if (!current || name.length < ACCOUNT_NAME.minLength) {
            return "name_invalid";
        }
        if (current.named && name === current.name) {
            return current;
        }
        if (current.renameAvailableAt > this.now()) {
            return "name_cooldown";
        }
        try {
            this.sql.prepare("UPDATE accounts SET name = ?, named = 1, renamed_at = ? WHERE id = ?").run(name, this.now(), id);
        }
        catch (e) {
            if (isUniqueViolation(e)) {
                return "name_taken";
            }
            throw e;
        }
        return this.find(id) ?? "name_invalid";
    }
    find(id) {
        if (typeof id !== "string") {
            return undefined;
        }
        const row = this.sql.prepare(`SELECT ${COLUMNS} FROM accounts WHERE id = ?`).get(id);
        return row && fromRow(row);
    }
    /** A session token for `account`. */
    issueToken(account) {
        return JWT.sign({ sub: account.id }, { expiresIn: SESSION_LENGTH });
    }
    /** The account a session token belongs to, or undefined for a missing, forged, expired or orphaned one. */
    async fromToken(token) {
        if (typeof token !== "string" || !token || !hasSessionSecret()) {
            return undefined;
        }
        try {
            const claims = await JWT.verify(token);
            return this.find(claims.sub);
        }
        catch {
            return undefined;
        }
    }
}
export const accounts = new Accounts();
