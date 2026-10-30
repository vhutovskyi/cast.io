import { randomBytes } from "node:crypto";
import { createEndpoint } from "colyseus";
import { isSignInProvider, SIGN_IN_PROVIDERS } from "../shared/accounts.js";
import { accounts, hasSessionSecret } from "./accounts.js";
const PROVIDERS = {
    discord: {
        authorizeUrl: "https://discord.com/oauth2/authorize",
        tokenUrl: "https://discord.com/api/oauth2/token",
        profileUrl: "https://discord.com/api/users/@me",
        // The narrowest Discord offers; its username and display name are ignored.
        scope: "identify",
        envPrefix: "DISCORD",
        userId: (profile) => profile.id,
    },
    google: {
        authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        profileUrl: "https://openidconnect.googleapis.com/v1/userinfo",
        // Just "openid": Google then sends no name, email or picture at all.
        scope: "openid",
        envPrefix: "GOOGLE",
        userId: (profile) => profile.sub,
    },
};
/** The server's calls to the providers. Tests swap it for a fake. */
export const providerHttp = { fetch: (url, init) => fetch(url, init) };
/** Ties the callback to the browser that started the sign-in (the `state` check). */
const STATE_COOKIE = "ligma_oauth";
/** A sign-in left this long in the popup has to start over. */
const STATE_MAX_AGE_S = 10 * 60;
/** Every route's prefix: also where the SDK looks (`client.auth.settings.path`). */
const PREFIX = "/auth";
function credentials(provider) {
    const { envPrefix } = PROVIDERS[provider];
    const id = process.env[`${envPrefix}_CLIENT_ID`];
    const secret = process.env[`${envPrefix}_CLIENT_SECRET`];
    return id && secret ? { id, secret } : undefined;
}
/** The providers players can sign in with here: credentials set, and a secret to sign sessions with. */
export function enabledProviders() {
    return hasSessionSecret() ? SIGN_IN_PROVIDERS.filter((provider) => credentials(provider) !== undefined) : [];
}
/** Where players reach this server: `PUBLIC_URL`, else what the request says (Fly sets `x-forwarded-proto`). */
function publicOrigin(ctx) {
    if (process.env.PUBLIC_URL) {
        return new URL(process.env.PUBLIC_URL).origin;
    }
    const proto = ctx.getHeader("x-forwarded-proto")?.split(",")[0].trim() || "http";
    return `${proto}://${ctx.getHeader("host") ?? "localhost"}`;
}
/** The game pages a finished sign-in may be handed to: our own, `AUTH_ALLOWED_ORIGINS`, and the Vite page in development. */
function allowedOrigins(ctx) {
    const extra = (process.env.AUTH_ALLOWED_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean);
    const dev = process.env.NODE_ENV === "production" ? [] : ["http://localhost:3000"];
    return [...new Set([publicOrigin(ctx), ...extra, ...dev])];
}
const redirectUri = (ctx, provider) => `${publicOrigin(ctx)}${PREFIX}/provider/${provider}/callback`;
function stateCookie(ctx, value, maxAge) {
    const secure = publicOrigin(ctx).startsWith("https:") ? "; Secure" : "";
    return `${STATE_COOKIE}=${value}; Path=${PREFIX}/provider; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}
function readCookie(ctx, name) {
    for (const part of (ctx.getHeader("cookie") ?? "").split(";")) {
        const [key, ...value] = part.trim().split("=");
        if (key === name) {
            return value.join("=");
        }
    }
    return undefined;
}
/**
 * The popup's last page: hands `result` to the game page that opened it.
 * JSON in a script — `<` escaped, since names are player-chosen.
 */
function popupResult(ctx, result, cookie) {
    const payload = JSON.stringify(result).replace(/</g, "\\u003c");
    const origins = JSON.stringify(allowedOrigins(ctx)).replace(/</g, "\\u003c");
    const html = `<!doctype html><meta charset="utf-8"><title>Signing in…</title><script>`
        + `for (const origin of ${origins}) { window.opener?.postMessage(${payload}, origin); }`
        + `</script>`;
    return new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "set-cookie": cookie },
    });
}
/** Trades the callback's code for the player's user id at the provider. */
async function identify(ctx, provider, code) {
    const spec = PROVIDERS[provider];
    const { id, secret } = credentials(provider);
    const tokenResponse = await providerHttp.fetch(spec.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({
            client_id: id, client_secret: secret, grant_type: "authorization_code", code, redirect_uri: redirectUri(ctx, provider),
        }),
    });
    const { access_token: accessToken } = await tokenResponse.json();
    if (!tokenResponse.ok || !accessToken) {
        throw new Error(`token exchange failed (${tokenResponse.status})`);
    }
    const profileResponse = await providerHttp.fetch(spec.profileUrl, { headers: { authorization: `Bearer ${accessToken}` } });
    if (!profileResponse.ok) {
        throw new Error(`profile request failed (${profileResponse.status})`);
    }
    const userId = spec.userId(await profileResponse.json());
    if (typeof userId !== "string" || !userId) {
        throw new Error("the provider sent no user id");
    }
    return userId;
}
/** The account behind a request's `Authorization: Bearer …` session, if any. */
async function sessionAccount(ctx) {
    const [scheme, token] = (ctx.getHeader("authorization") ?? "").split(" ");
    return scheme?.toLowerCase() === "bearer" ? accounts.fromToken(token) : undefined;
}
const jsonResponse = (body, status) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
export const signInEndpoints = {
    /** Which sign-in buttons the lobby shows. */
    "auth-providers": createEndpoint(`${PREFIX}/providers`, { method: "GET" }, async () => ({ providers: enabledProviders() })),
    /** The popup opens here: off to the provider's consent page, `state` remembered in a cookie. */
    "auth-provider-start": createEndpoint(`${PREFIX}/provider/:provider`, { method: "GET" }, async (ctx) => {
        const provider = ctx.params.provider;
        if (!isSignInProvider(provider) || !enabledProviders().includes(provider)) {
            return new Response("This server can't sign in with that provider.", { status: 404 });
        }
        const state = randomBytes(16).toString("hex");
        const url = new URL(PROVIDERS[provider].authorizeUrl);
        url.search = new URLSearchParams({
            client_id: credentials(provider).id,
            redirect_uri: redirectUri(ctx, provider),
            response_type: "code",
            scope: PROVIDERS[provider].scope,
            state,
        }).toString();
        return new Response(null, {
            status: 302,
            headers: { location: url.toString(), "set-cookie": stateCookie(ctx, `${provider}.${state}`, STATE_MAX_AGE_S) },
        });
    }),
    /** The provider sends the popup back here with a code: sign in, and hand the session to the game page. */
    "auth-provider-callback": createEndpoint(`${PREFIX}/provider/:provider/callback`, { method: "GET" }, async (ctx) => {
        const provider = ctx.params.provider;
        const query = (ctx.query ?? {});
        const cleared = stateCookie(ctx, "", 0);
        const fail = (error) => popupResult(ctx, { user: null, token: null, error }, cleared);
        if (!isSignInProvider(provider) || !enabledProviders().includes(provider)) {
            return fail("unknown_provider");
        }
        const expected = readCookie(ctx, STATE_COOKIE);
        if (!expected || typeof query.state !== "string" || expected !== `${provider}.${query.state}`) {
            return fail("invalid_state");
        }
        if (typeof query.error === "string") {
            return fail(query.error);
        }
        if (typeof query.code !== "string" || !query.code) {
            return fail("missing_code");
        }
        try {
            const account = accounts.signIn(provider, await identify(ctx, provider, query.code));
            const token = await accounts.issueToken(account);
            return popupResult(ctx, { user: account, token }, cleared);
        }
        catch (e) {
            console.error(`sign-in with ${provider} failed:`, e);
            return fail("sign_in_failed");
        }
    }),
    /** `client.auth` checks a remembered session here on page load. */
    "auth-userdata": createEndpoint(`${PREFIX}/userdata`, { method: "GET" }, async (ctx) => {
        const account = await sessionAccount(ctx);
        if (!account) {
            return jsonResponse({ error: "not_signed_in" }, 401);
        }
        return { user: account };
    }),
    /** Choose the ranked name others see. */
    "auth-name": createEndpoint(`${PREFIX}/name`, { method: "POST" }, async (ctx) => {
        const account = await sessionAccount(ctx);
        if (!account) {
            return jsonResponse({ error: "not_signed_in" }, 401);
        }
        const result = accounts.rename(account.id, ctx.body?.name);
        if (typeof result === "string") {
            return jsonResponse({ error: result }, 400);
        }
        return { user: result };
    }),
};
