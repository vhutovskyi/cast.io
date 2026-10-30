/**
 * Signing in, for ranked play. Shared code: the backend runs the OAuth flow,
 * the lobby offers the providers.
 */
import { NICKNAME_MAX } from "./constants.js";
/** Every provider the server knows how to sign in with, in button order. */
export const SIGN_IN_PROVIDERS = ["discord", "google"];
export function isSignInProvider(value) {
    return SIGN_IN_PROVIDERS.includes(value);
}
/**
 * Ranked names: unique (ignoring case), and this long once cleaned up. The
 * first one a player chooses is free; after that, one change per cooldown —
 * so a name stays tied to a reputation.
 */
export const ACCOUNT_NAME = { minLength: 3, maxLength: NICKNAME_MAX, renameCooldownMs: 30 * 24 * 60 * 60 * 1000 };
