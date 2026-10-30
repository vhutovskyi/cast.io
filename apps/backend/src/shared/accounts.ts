/**
 * Signing in, for ranked play. Shared code: the backend runs the OAuth flow,
 * the lobby offers the providers.
 */
import { NICKNAME_MAX } from "./constants.js";

/** Every provider the server knows how to sign in with, in button order. */
export const SIGN_IN_PROVIDERS = ["discord", "google"] as const;
export type SignInProvider = (typeof SIGN_IN_PROVIDERS)[number];

export function isSignInProvider(value: unknown): value is SignInProvider {
  return SIGN_IN_PROVIDERS.includes(value as SignInProvider);
}

/** The signed-in player, as the client sees them (`client.auth`'s user). */
export interface AccountUser {
  id: string;
  /**
   * Their ranked name, shown to everyone they play: one they chose, or until
   * they do, a made-up "Mage-…" one. Never their name at the provider.
   */
  name: string;
  /** Whether they've chosen `name` themselves. */
  named: boolean;
  /** Wall-clock ms they may change their name again from (`ACCOUNT_NAME.renameCooldownMs`); 0 = any time. */
  renameAvailableAt: number;
  provider: SignInProvider;
}

/**
 * Ranked names: unique (ignoring case), and this long once cleaned up. The
 * first one a player chooses is free; after that, one change per cooldown —
 * so a name stays tied to a reputation.
 */
export const ACCOUNT_NAME = { minLength: 3, maxLength: NICKNAME_MAX, renameCooldownMs: 30 * 24 * 60 * 60 * 1000 } as const;

/** `POST /auth/name`: choose a ranked name. Answers `{ user }`, or 400 `{ error }`. */
export interface SetNameRequest {
  name: string;
}
export type SetNameError = "name_invalid" | "name_taken" | "name_cooldown";

/** `GET /auth/providers`: the providers this server has credentials for. */
export interface SignInProvidersResponse {
  providers: SignInProvider[];
}
