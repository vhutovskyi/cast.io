import type { Avatar } from "../render/scene";

/** What a showpiece hangs from: a body and its right hand, like a remote player's avatar. */
export type ShowpieceHolder = Pick<Avatar, "group" | "hand">;

/**
 * A skill's held model shown outside a match (the lobby's mage), at rest and
 * ready: what a remote player holding it looks like. `now` is
 * performance.now() ms.
 */
export interface Showpiece {
  update(now: number): void;
  dispose(): void;
}
