import assert from "assert";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ColyseusTestServer } from "@colyseus/testing";
import { JWT } from "@colyseus/auth";

import type appConfig from "../src/app.config.js";
import { testServer } from "./testServer.js";
import { Accounts, accounts, type Account } from "../src/accounts/accounts.js";
import { MIGRATIONS, openDatabase } from "../src/accounts/database.js";
import { providerHttp } from "../src/accounts/oauth.js";
import { ACCOUNT_NAME } from "../src/shared/accounts.js";
import { SqliteRatingStore, type RatingRecord } from "../src/ranked/ratingStore.js";

const record: RatingRecord = {
  rating: 1623.5, deviation: 71.25, volatility: 0.0599, games: 12, wins: 7, lastPlayedAt: 1_700_000_000_000, dodges: 1, lastDodgeAt: 1_699_000_000_000, bannedUntil: 1_699_000_060_000,
};

describe("accounts", () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "ligma-db-"));
    JWT.settings.secret = "test-secret";
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  describe("the database", () => {
    it("keeps accounts and ratings across a restart", () => {
      const path = join(dir, "restart.db");
      const first = new Accounts(() => openDatabase(path));
      const ann = first.rename(first.signIn("discord", "123").id, "Ann") as Account;
      new SqliteRatingStore(openDatabase(path)).set(ann.id, record);

      // A new process: the same file, opened afresh.
      const second = new Accounts(() => openDatabase(path));
      assert.deepStrictEqual(second.find(ann.id), ann);
      assert.deepStrictEqual(new SqliteRatingStore(openDatabase(path)).get(ann.id), record);
    });

    it("runs each schema step once", () => {
      const path = join(dir, "migrate.db");
      openDatabase(path).close();
      const db = openDatabase(path);
      assert.strictEqual((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, MIGRATIONS.length);
    });

    it("forgets the provider names stored before players chose their own", () => {
      const path = join(dir, "v1.db");
      const v1 = new DatabaseSync(path);
      v1.exec(MIGRATIONS[0]);
      v1.exec("PRAGMA user_version = 1");
      v1.prepare("INSERT INTO accounts (id, provider, provider_user_id, name, created_at) VALUES (?, ?, ?, ?, ?)")
        .run("6f1c2a9e-0000-4000-8000-000000000001", "google", "g-1", "Jane Q. Public", 1);
      v1.close();

      const migrated = new Accounts(() => openDatabase(path)).find("6f1c2a9e-0000-4000-8000-000000000001");
      assert.deepStrictEqual(migrated, { id: "6f1c2a9e-0000-4000-8000-000000000001", name: "Mage-6f1c2a9e00", named: false, renameAvailableAt: 0, provider: "google" });
      const everything = JSON.stringify(openDatabase(path).prepare("SELECT * FROM accounts").all());
      assert.ok(!everything.includes("Jane"), "the real name is gone from the database");
    });

    it("overwrites a rating in place, and has none for a stranger", () => {
      const store = new SqliteRatingStore(openDatabase(":memory:"));
      assert.strictEqual(store.get("nobody"), undefined);
      store.set("a", record);
      store.set("a", { ...record, rating: 1700, games: 13 });
      assert.deepStrictEqual(store.get("a"), { ...record, rating: 1700, games: 13 });
    });
  });

  describe("signing in", () => {
    let service: Accounts;
    let now: number;
    beforeEach(() => {
      now = 1_000_000_000;
      service = new Accounts();
      service.reset(openDatabase(":memory:"), () => now);
    });

    it("is always the same account for the same provider identity", () => {
      const first = service.signIn("discord", "42");
      assert.deepStrictEqual(service.signIn("discord", "42"), first);
      assert.notStrictEqual(service.signIn("google", "42").id, first.id, "another provider is another account");
    });

    it("starts every account on a made-up name, never one from the provider", () => {
      const fresh = service.signIn("google", "g-7");
      assert.match(fresh.name, /^Mage-\d{6}$/);
      assert.strictEqual(fresh.named, false);
    });

    it("lets players choose a unique ranked name, cleaned up", () => {
      const ann = service.signIn("discord", "1");
      const bob = service.signIn("discord", "2");
      assert.deepStrictEqual(service.rename(ann.id, "  Ann\u0000\n  the\tBold "),
        { ...ann, name: "Ann the Bold", named: true, renameAvailableAt: now + ACCOUNT_NAME.renameCooldownMs });
      assert.strictEqual(service.rename(bob.id, "ANN THE BOLD"), "name_taken", "unique, whatever the case");
      assert.strictEqual(service.rename(bob.id, " a "), "name_invalid", "too short");
      assert.strictEqual(service.rename(bob.id, 42), "name_invalid");
      assert.strictEqual(service.rename("nobody", "Ghost"), "name_invalid");
      assert.strictEqual((service.rename(bob.id, "B".repeat(40)) as Account).name, "B".repeat(16), "capped; the refusals before cost nothing");
    });

    it("lets a name change only once per cooldown, the first choice included", () => {
      const ann = service.rename(service.signIn("discord", "1").id, "Ann") as Account;
      now += 1000;
      assert.strictEqual(service.rename(ann.id, "Annabel"), "name_cooldown", "not straight after choosing");
      assert.strictEqual(service.rename(ann.id, "ann"), "name_cooldown", "re-casing is a change too");
      assert.deepStrictEqual(service.rename(ann.id, "Ann"), ann, "saving the same name is no change, and spends nothing");

      now = ann.renameAvailableAt;
      const renamed = service.rename(ann.id, "Annabel") as Account;
      assert.strictEqual(renamed.name, "Annabel", "once the cooldown is over");
      assert.strictEqual(renamed.renameAvailableAt, now + ACCOUNT_NAME.renameCooldownMs, "and it starts over");
      assert.strictEqual(service.rename(ann.id, "Annie"), "name_cooldown");
      assert.strictEqual(service.find(ann.id).name, "Annabel");
    });

    it("issues session tokens that lead back to the account, and nothing for a forged or orphaned one", async () => {
      const ann = service.signIn("google", "g-1");
      assert.deepStrictEqual(await service.fromToken(await service.issueToken(ann)), ann);
      assert.strictEqual(await service.fromToken("garbage"), undefined);
      assert.strictEqual(await service.fromToken(undefined), undefined);
      assert.strictEqual(await service.fromToken(await service.issueToken({ ...ann, id: "gone" })), undefined);
      JWT.settings.secret = "another secret";
      const forged = await service.issueToken(ann);
      JWT.settings.secret = "test-secret";
      assert.strictEqual(await service.fromToken(forged), undefined);
    });
  });

  describe("OAuth sign-in over HTTP", () => {
    let colyseus: ColyseusTestServer<typeof appConfig>;
    const realFetch = providerHttp.fetch;
    const env = { DISCORD_CLIENT_ID: "discord-id", DISCORD_CLIENT_SECRET: "discord-secret" };

    before(async () => {
      colyseus = await testServer();
      Object.assign(process.env, env);
    });
    after(() => {
      for (const key of Object.keys(env)) { delete process.env[key]; }
      providerHttp.fetch = realFetch;
    });
    beforeEach(() => accounts.reset(openDatabase(":memory:")));

    const url = (path: string) => (colyseus.sdk as unknown as { getHttpEndpoint(path: string): string }).getHttpEndpoint(path);
    const get = (path: string, headers: Record<string, string> = {}) => fetch(url(path), { redirect: "manual", headers });

    /** A provider, as far as the server can tell: a token exchange and a profile. */
    function fakeProvider(tokenUrl: string, profileUrl: string, profile: Record<string, unknown>) {
      const calls: { url: string; body?: string }[] = [];
      providerHttp.fetch = async (target, init) => {
        calls.push({ url: target, body: init?.body?.toString() });
        if (target === tokenUrl) { return Response.json({ access_token: "access-123" }); }
        if (target === profileUrl) {
          assert.strictEqual((init?.headers as Record<string, string>).authorization, "Bearer access-123");
          return Response.json(profile);
        }
        throw new Error(`unexpected request to ${target}`);
      };
      return calls;
    }
    const fakeDiscord = (profile: Record<string, unknown>) =>
      fakeProvider("https://discord.com/api/oauth2/token", "https://discord.com/api/users/@me", profile);

    /** Starts a sign-in: the provider's consent URL and the state cookie. */
    async function start(provider = "discord") {
      const response = await get(`/auth/provider/${provider}`);
      assert.strictEqual(response.status, 302);
      const location = new URL(response.headers.get("location"));
      const cookie = response.headers.get("set-cookie").split(";")[0];
      return { location, cookie, state: location.searchParams.get("state") };
    }

    it("offers only the providers it has credentials for", async () => {
      assert.deepStrictEqual(await (await get("/auth/providers")).json(), { providers: ["discord"] });
      assert.strictEqual((await get("/auth/provider/google")).status, 404);
    });

    it("sends the popup to the provider's consent page, remembering the state in a cookie", async () => {
      const { location, cookie, state } = await start();
      assert.strictEqual(location.origin + location.pathname, "https://discord.com/oauth2/authorize");
      assert.strictEqual(location.searchParams.get("client_id"), "discord-id");
      assert.strictEqual(location.searchParams.get("scope"), "identify");
      assert.strictEqual(location.searchParams.get("redirect_uri"), url("/auth/provider/discord/callback"));
      assert.match(state, /^[0-9a-f]{32}$/);
      assert.strictEqual(cookie, `ligma_oauth=discord.${state}`);
    });

    it("signs in and hands the session to our own page only — never to any origin", async () => {
      // A returning player whose chosen name tries to break out of the popup's script.
      const returning = accounts.rename(accounts.signIn("discord", "998877").id, "</script><b>") as Account;
      const calls = fakeDiscord({ id: "998877", username: "ann", global_name: "Ann" });
      const { cookie, state } = await start();
      const response = await get(`/auth/provider/discord/callback?code=the-code&state=${state}`, { cookie });
      const html = await response.text();

      assert.match(calls[0].body, /code=the-code/);
      assert.match(calls[0].body, /client_secret=discord-secret/);
      assert.ok(!html.includes("'*'") && !html.includes('"*"'), "never posted to every origin");
      assert.ok(html.includes(JSON.stringify(new URL(url("/")).origin)), "posted to our own origin");
      assert.ok(!html.includes("</script><b>"), "a player's name can't break out of the script");
      assert.match(response.headers.get("set-cookie"), /ligma_oauth=;.*Max-Age=0/, "the state is used up");

      const payload = JSON.parse(html.match(/postMessage\((\{.*?\}), origin\)/)[1]);
      assert.deepStrictEqual(payload.user, returning, "their account, with the name they chose");
      const account = await accounts.fromToken(payload.token);
      assert.strictEqual(account.id, payload.user.id);
      assert.strictEqual(account.provider, "discord");

      const again = fakeDiscord({ id: "998877", username: "ann" });
      const second = await start();
      const html2 = await (await get(`/auth/provider/discord/callback?code=c2&state=${second.state}`, { cookie: second.cookie })).text();
      assert.strictEqual(JSON.parse(html2.match(/postMessage\((\{.*?\}), origin\)/)[1]).user.id, account.id, "the same Discord user, the same account");
      assert.strictEqual(again.length, 2);
    });

    it("refuses a callback without the state this browser started with", async () => {
      const calls = fakeDiscord({ id: "1" });
      const { cookie, state } = await start();
      for (const [query, headers] of [
        [`code=x&state=${state}`, {}],
        [`code=x&state=wrong`, { cookie }],
        [`code=x&state=${state}`, { cookie: "ligma_oauth=google." + state }],
      ] as const) {
        const html = await (await get(`/auth/provider/discord/callback?${query}`, headers)).text();
        assert.match(html, /"error":"invalid_state"/);
      }
      assert.strictEqual(calls.length, 0, "never even asked the provider");
    });

    it("passes on a refused consent, and a failed exchange, without signing anyone in", async () => {
      const { cookie, state } = await start();
      assert.match(await (await get(`/auth/provider/discord/callback?error=access_denied&state=${state}`, { cookie })).text(), /"error":"access_denied"/);

      providerHttp.fetch = async () => Response.json({ error: "invalid_grant" }, { status: 400 });
      const second = await start();
      assert.match(await (await get(`/auth/provider/discord/callback?code=x&state=${second.state}`, { cookie: second.cookie })).text(), /"error":"sign_in_failed"/);
    });

    it("asks Google for nothing but an id, and keeps no name it sends anyway", async () => {
      Object.assign(process.env, { GOOGLE_CLIENT_ID: "google-id", GOOGLE_CLIENT_SECRET: "google-secret" });
      try {
        const { location, cookie, state } = await start("google");
        assert.strictEqual(location.searchParams.get("scope"), "openid", "no profile, no email");
        fakeProvider("https://oauth2.googleapis.com/token", "https://openidconnect.googleapis.com/v1/userinfo",
          { sub: "g-555", name: "Jane Q. Public", given_name: "Jane", email: "jane@example.com" });
        const html = await (await get(`/auth/provider/google/callback?code=c&state=${state}`, { cookie })).text();
        const { user } = JSON.parse(html.match(/postMessage\((\{.*?\}), origin\)/)[1]);
        assert.match(user.name, /^Mage-\d{6}$/);
        assert.strictEqual(user.named, false, "they'll be asked to choose one");
        assert.ok(!html.includes("Jane"), "never shown");
        assert.ok(!JSON.stringify(accounts.find(user.id)).includes("Jane"), "never stored");
      } finally {
        delete process.env.GOOGLE_CLIENT_ID;
        delete process.env.GOOGLE_CLIENT_SECRET;
      }
    });

    it("lets a signed-in player choose their ranked name", async () => {
      const ann = accounts.signIn("discord", "11");
      const bob = accounts.rename(accounts.signIn("discord", "12").id, "Bob") as Account;
      const token = await accounts.issueToken(ann);
      const setName = (name: unknown, headers: Record<string, string> = { authorization: `Bearer ${token}` }) =>
        fetch(url("/auth/name"), { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ name }) });

      const refuse = async (name: unknown, error: string) => {
        const refused = await setName(name);
        assert.strictEqual(refused.status, 400);
        assert.deepStrictEqual(await refused.json(), { error });
      };
      await refuse(bob.name, "name_taken");
      await refuse("x", "name_invalid");
      await refuse(null, "name_invalid");
      assert.strictEqual((await setName("Sneaky", {})).status, 401, "signed in only");

      const ok = await setName("Ann");
      assert.strictEqual(ok.status, 200);
      const { user } = await ok.json();
      assert.deepStrictEqual({ ...user, renameAvailableAt: 0 }, { ...ann, name: "Ann", named: true });
      assert.ok(user.renameAvailableAt > Date.now(), "told when they may rename again");
      await refuse("Annabel", "name_cooldown");
      assert.strictEqual(accounts.find(ann.id).name, "Ann");
    });

    it("tells a page whether its remembered session is still good", async () => {
      const ann = accounts.signIn("discord", "5");
      const token = await accounts.issueToken(ann);
      assert.deepStrictEqual(await (await get("/auth/userdata", { authorization: `Bearer ${token}` })).json(), { user: ann });
      assert.strictEqual((await get("/auth/userdata")).status, 401);
      assert.strictEqual((await get("/auth/userdata", { authorization: "Bearer junk" })).status, 401);
    });
  });
});
