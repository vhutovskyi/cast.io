import { TICK_RATE } from "../shared/constants.js";

/** The slice of a Colyseus input accessor the pacer needs. */
export interface InputQueue<I> {
  readonly size: number;
  next(): I | undefined;
  take(n: number): I[];
}

/** Starting and minimum buffer depth, in ticks: one input of headroom. */
export const MIN_TARGET = 1;
/**
 * Deepest the buffer may grow for a very bursty connection: ~200 ms. Sized in
 * time, not ticks, so a faster tick rate doesn't shrink the cushion.
 */
export const MAX_TARGET = Math.round(TICK_RATE / 5);
/**
 * Beyond this many queued inputs (~330 ms) the oldest are dropped, not replayed.
 * A dropped input still counts as acknowledged, so its owner's prediction
 * (which applied it) snaps back: keep this well past ordinary jitter.
 */
export const MAX_BACKLOG = Math.round(TICK_RATE / 3);
/** Ticks without a starvation before the target eases back down by one. */
export const SHRINK_AFTER_TICKS = TICK_RATE * 5;

interface PacerState {
  /** Inputs to keep queued as a cushion against arrival jitter. */
  target: number;
  /** False after the queue ran dry: wait for `target` inputs before resuming. */
  primed: boolean;
  /** Ticks spent waiting to re-prime; never more than `target`. */
  ticksWaiting: number;
  ticksSinceStarved: number;
}

/**
 * A per-player jitter buffer for movement inputs. Clients send one input per
 * tick, but over a bursty connection they arrive in clumps — nothing for a
 * while, then several at once. Applying every queued input in one tick makes
 * the player stand still, then jump: everyone else sees them teleport, and a
 * player could hold inputs back on purpose and release them as one big leap.
 *
 * Instead each tick hands out one input, keeping a small adaptive cushion:
 * - running dry raises the cushion by a tick and waits (at most that many
 *   ticks) for it to refill, so the next gap of that size is absorbed
 *   instead of freezing the player;
 * - a long calm stretch lowers it again, so a good connection pays ~1 tick;
 * - a backlog above target is worked off at two inputs per tick;
 * - anything past MAX_BACKLOG is stale and dropped.
 *
 * Inputs are still applied in order and acknowledged as consumed, so the
 * owner's client-side prediction keeps matching the server.
 */
export class InputPacer {
  private players = new Map<string, PacerState>();

  /** The inputs to apply this tick for one player, oldest first. */
  take<I>(sessionId: string, queue: InputQueue<I>): I[] {
    const state = this.stateFor(sessionId);

    if (queue.size > MAX_BACKLOG) {
      queue.take(queue.size - MAX_BACKLOG);
    }

    if (queue.size === 0) {
      if (state.primed) {
        state.primed = false;
        state.target = Math.min(state.target + 1, MAX_TARGET);
      }
      state.ticksSinceStarved = 0;
      return [];
    }

    // Refill the cushion before resuming — but wait no longer than its own
    // length, so a player who sends one last input and goes quiet isn't stuck.
    if (!state.primed) {
      if (queue.size < state.target && ++state.ticksWaiting < state.target) { return []; }
      state.primed = true;
      state.ticksWaiting = 0;
    }

    if (++state.ticksSinceStarved >= SHRINK_AFTER_TICKS) {
      state.ticksSinceStarved = 0;
      state.target = Math.max(state.target - 1, MIN_TARGET);
    }

    return queue.take(queue.size > state.target + 2 ? 2 : 1);
  }

  /** The current cushion for a player, in ticks (for tests and diagnostics). */
  targetOf(sessionId: string): number {
    return this.stateFor(sessionId).target;
  }

  remove(sessionId: string) {
    this.players.delete(sessionId);
  }

  private stateFor(sessionId: string): PacerState {
    let state = this.players.get(sessionId);
    if (!state) {
      state = { target: MIN_TARGET, primed: false, ticksWaiting: 0, ticksSinceStarved: 0 };
      this.players.set(sessionId, state);
    }
    return state;
  }
}
