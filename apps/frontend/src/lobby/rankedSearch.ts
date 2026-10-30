import { CloseCode, type Room } from "@colyseus/sdk";
import { RANKED_QUEUE_MESSAGE } from "@ligma/backend/shared/messages";
import type { RankedMatchFound, RankedQueueOptions, RankedQueueStatus } from "@ligma/backend/shared/ranked";
import { client } from "../net/client";
import { formatRating } from "../ui/ranked";

/** The lobby's "Searching for a ranked duel" panel. */
export interface RankedSearchUi {
  root: HTMLElement;
  /** "Searching for a ranked duel · 0:42", or "Match found: Blaze (1532)". */
  title: HTMLElement;
  /** "Your rating 1500? · within ±520 · 3 searching". */
  detail: HTMLElement;
  cancel: HTMLButtonElement;
}

const clockTime = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/**
 * Searching for a ranked duel: in the `ranked_queue` room while it lasts.
 * The server pairs and hands over a seat in the match; `onFound` joins it.
 * Leaving the room (Cancel, or `stop()`) stops searching.
 */
export class RankedSearch {
  private room: Room | undefined;
  /** Bumped by every start and stop, so a join that lands after a Cancel is left at once. */
  private attempt = 0;

  constructor(
    private readonly ui: RankedSearchUi,
    private readonly onFound: (found: RankedMatchFound) => void,
    private readonly onError: (message: string) => void,
  ) {
    ui.cancel.addEventListener("click", () => this.stop());
  }

  get searching() {
    return this.attempt % 2 === 1;
  }

  /** Starts searching (a no-op while already searching). `note` is shown until the first status arrives. */
  async start(options: RankedQueueOptions, note = "") {
    if (this.searching) { return; }
    const attempt = ++this.attempt;
    this.show("Searching for a ranked duel", note || "Joining the queue…");
    try {
      const room = await client.joinOrCreate("ranked_queue", options);
      if (attempt !== this.attempt) { room.leave(); return; }
      this.room = room;
      room.onMessage(RANKED_QUEUE_MESSAGE.status, (status: RankedQueueStatus) => {
        this.show(
          `Searching for a ranked duel · ${clockTime(status.waitedMs)}`,
          `Your rating ${formatRating(status.rating, status.deviation)} · within ±${status.window} · ${status.searching} searching`,
        );
      });
      room.onMessage(RANKED_QUEUE_MESSAGE.matchFound, (found: RankedMatchFound) => {
        this.stop(false);
        this.show(`Match found: ${found.opponent.name} (${found.opponent.rating})`, "Joining…");
        this.onFound(found);
      });
      room.onLeave((code) => {
        // Dropped by the server, not by us: nothing is searching any more.
        if (this.room !== room) { return; }
        this.stop();
        if (code === CloseCode.SERVER_SHUTDOWN) { this.onError("The server is restarting for an update. Search again in a minute."); }
      });
    } catch (e) {
      if (attempt !== this.attempt) { return; }
      this.stop();
      this.onError(e instanceof Error ? e.message : String(e));
    }
  }

  /** Stops searching; `hide` false keeps the panel up (a match found, being joined). */
  stop(hide = true) {
    if (this.searching) { this.attempt++; }
    const room = this.room;
    this.room = undefined;
    room?.leave();
    if (hide) { this.ui.root.hidden = true; }
  }

  /** Hides the panel, once whatever it was showing is over. */
  hide() {
    if (!this.searching) { this.ui.root.hidden = true; }
  }

  private show(title: string, detail: string) {
    this.ui.root.hidden = false;
    this.ui.title.textContent = title;
    this.ui.detail.textContent = detail;
    this.ui.cancel.hidden = !this.searching;
  }
}
