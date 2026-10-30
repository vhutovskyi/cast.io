import type { MatchPhase } from "@ligma/backend/rooms/schema/MyRoomState";
import { BATTLE_ROYALE } from "@ligma/backend/shared/gameModes";
import type { RankedResult } from "@ligma/backend/shared/ranked";
import { isWaterClone } from "@ligma/backend/skills/waterClone/waterCloneConfig";
import type { ArenaRoom } from "../net/arenaRoom";
import { formatRating } from "../ui/ranked";

/** The duel / battle royale banner, top centre. */
export interface MatchHudUi {
  root: HTMLElement;
  /** "Round 2 · First to 3 · You 1 – 0 Blaze". */
  score: HTMLElement;
  /** "You take round 2", "Blaze wins the match". */
  headline: HTMLElement;
  /** What to do next: "Click to ready up". */
  hint: HTMLElement;
  /** Full-screen tint after a match: blue for the winner, red for the loser. */
  result: HTMLElement;
  resultTitle: HTMLElement;
  /** The menu's "Click to play", which says what the click does. */
  overlayTitle: HTMLElement;
}

interface Shown {
  score: string;
  headline: string;
  hint: string;
  /** Ready button: null = hidden, else whether we are ready. */
  ready: boolean | null;
  /** How our last match ended, while its result is up. */
  result: "win" | "lose" | null;
}

/**
 * Duel and battle royale: round, score and what to do next, redrawn from the
 * synced match state. Names are player-typed, so they only ever go through
 * `textContent`. Free-for-all shows none of it.
 */
export class MatchHud {
  private shown = "";
  /** Ranked: how our match went for our rating, once the server has said. */
  private rankedResult: RankedResult | null = null;

  constructor(
    private readonly room: ArenaRoom,
    private readonly ui: MatchHudUi,
    private readonly readyButton: HTMLButtonElement,
  ) {}

  /** Per frame; only touches the page when something changed. */
  update() {
    const next = this.describe();
    const key = JSON.stringify(next);
    if (key === this.shown) { return; }
    this.shown = key;

    this.ui.root.hidden = next === null;
    this.readyButton.hidden = next?.ready == null;
    this.ui.result.hidden = !next?.result;
    this.ui.overlayTitle.textContent = next?.ready === false ? "Click to ready up" : "Click to play";
    if (!next) { return; }
    if (next.result) {
      this.ui.result.className = next.result;
      this.ui.resultTitle.textContent = next.result === "win" ? "Winner" : "Loser";
    }
    this.ui.score.textContent = next.score;
    this.ui.headline.textContent = next.headline;
    this.ui.hint.textContent = next.hint;
    this.readyButton.textContent = next.ready ? "Not ready" : "Ready";
    this.readyButton.classList.toggle("is-ready", next.ready === true);
  }

  /** Ranked: the server's word on our match, shown with its result. */
  showRankedResult(result: RankedResult) {
    this.rankedResult = result;
  }

  /** Ranked: our match has been rated. */
  get hasRankedResult() {
    return this.rankedResult !== null;
  }

  hide() {
    this.shown = "";
    this.rankedResult = null;
    this.ui.root.hidden = true;
    this.ui.result.hidden = true;
    this.ui.overlayTitle.textContent = "Click to play";
    this.readyButton.hidden = true;
  }

  private describe(): Shown | null {
    const { match, players } = this.room.state;
    if (match.mode === "battleRoyale") { return this.describeBattleRoyale(); }
    if (match.mode !== "duel") { return null; }
    const self = players.get(this.room.sessionId);
    if (!self) { return null; }
    // A Water Clone is in the players too, but it is nobody's opponent.
    const [opponentId, opponent] = [...players].find(([id, p]) => id !== this.room.sessionId && !isWaterClone(p)) ?? ["", undefined];
    const nameOf = (id: string) => id === this.room.sessionId ? "You" : id === opponentId ? opponent!.name : "";

    const shown: Shown = {
      score: `${match.ranked ? "Ranked · " : ""}${match.round > 0 ? `Round ${match.round} · ` : ""}First to ${match.roundsToWin} · You ${self.wins} – ${opponent?.wins ?? 0} ${opponent?.name ?? "…"}`,
      headline: "",
      hint: "",
      ready: null,
      result: null,
    };

    switch (match.phase as MatchPhase) {
      case "waiting": {
        const winner = nameOf(match.matchWinnerId);
        // Warm-up: say plainly that hits don't count, so nobody mistakes it for the fight.
        shown.headline = !match.matchWinnerId ? (opponent ? "Warm-up — hits don't count" : "Waiting for an opponent")
          : winner === "You" ? "You win the match!"
          : winner ? `${winner} wins the match` : "Match over";
        if (match.ranked) {
          // One match, rated: the result and what it did to our rating stay up until the room closes.
          const result = this.rankedResult;
          if (winner) { shown.result = winner === "You" ? "win" : "lose"; }
          if (!match.matchWinnerId && !opponent) { shown.headline = "Waiting for your opponent to join"; }
          if (result?.forfeit && result.won) { shown.headline = "Your opponent left — you win the match!"; }
          if (result) {
            const delta = Math.round(result.ratingAfter) - Math.round(result.ratingBefore);
            shown.hint = `Rating ${Math.round(result.ratingBefore)} → ${formatRating(result.ratingAfter, result.deviation)} (${delta >= 0 ? "+" : ""}${delta})`;
          }
          break;
        }
        if (match.autoStart) {
          // Quick Play: no Ready — the result stays up until the next match starts on its own.
          if (winner) { shown.result = winner === "You" ? "win" : "lose"; }
          shown.hint = opponent ? "The next match starts in a moment" : "The match starts as soon as someone joins";
          break;
        }
        shown.ready = self.ready;
        // The result stays up until we ready up for the next match.
        if (winner && !self.ready) { shown.result = winner === "You" ? "win" : "lose"; }
        const readyCount = [...players.values()].filter((p) => p.ready && !isWaterClone(p)).length;
        shown.hint = !self.ready ? `Click to ready up (${readyCount}/2 ready)`
          : opponent && !opponent.ready ? `Waiting for ${opponent.name} to ready up`
          : !opponent ? "The match starts once someone joins and readies up" : "";
        break;
      }
      case "roundOver": {
        const winner = nameOf(match.roundWinnerId);
        shown.headline = !winner ? "Draw — nobody scores"
          : winner === "You" ? `You take round ${match.round}` : `${winner} takes round ${match.round}`;
        break;
      }
    }
    // Ranked: the opponent dropped, the fight is paused while their seat is held.
    if (match.awaitingId && match.awaitingId !== this.room.sessionId) {
      shown.headline = `${players.get(match.awaitingId)?.name ?? "Your opponent"} disconnected — waiting ${match.awaitingSeconds}s for them`;
      shown.hint = "The fight is paused: hits don't count";
    }
    return shown;
  }

  /** Like the duel's, with the leader standing in for the opponent. */
  private describeBattleRoyale(): Shown | null {
    const { match, players } = this.room.state;
    const self = players.get(this.room.sessionId);
    if (!self) { return null; }
    // Water Clones are in the players too, but they are nobody's seat.
    const others = [...players].filter(([id, p]) => id !== this.room.sessionId && !isWaterClone(p));
    const seated = others.length + 1;
    const leader = others.map(([, p]) => p).sort((a, b) => b.wins - a.wins)[0];
    const nameOf = (id: string) => id === this.room.sessionId ? "You" : players.get(id)?.name ?? "";

    const shown: Shown = {
      score: `${match.round > 0 ? `Round ${match.round} · ` : ""}First to ${match.roundsToWin} · You ${self.wins}`
        + (leader ? ` · Best of the rest: ${leader.name} ${leader.wins}` : ""),
      headline: "",
      hint: "",
      ready: null,
      result: null,
    };

    switch (match.phase as MatchPhase) {
      case "waiting": {
        const winner = nameOf(match.matchWinnerId);
        shown.headline = !match.matchWinnerId ? (seated >= BATTLE_ROYALE.minPlayers ? "Warm-up — hits don't count" : "Waiting for opponents")
          : winner === "You" ? "You win the match!"
          : winner ? `${winner} wins the match` : "Match over";
        if (match.autoStart) {
          // Quick Play: no Ready — the result stays up until the next match starts on its own.
          if (winner) { shown.result = winner === "You" ? "win" : "lose"; }
          shown.hint = seated < BATTLE_ROYALE.minPlayers ? "The match starts as soon as someone joins" : "The next match starts in a moment";
          break;
        }
        shown.ready = self.ready;
        if (winner && !self.ready) { shown.result = winner === "You" ? "win" : "lose"; }
        const readyCount = (self.ready ? 1 : 0) + others.filter(([, p]) => p.ready).length;
        shown.hint = seated < BATTLE_ROYALE.minPlayers ? "The match starts once someone joins and everyone readies up"
          : !self.ready ? `Click to ready up (${readyCount}/${seated} ready)`
          : `Waiting for everyone to ready up (${readyCount}/${seated} ready)`;
        break;
      }
      case "fighting":
        if (self.hp <= 0) { shown.headline = "You're out — back next round"; }
        break;
      case "roundOver": {
        const winner = nameOf(match.roundWinnerId);
        shown.headline = !winner ? "Draw — nobody scores"
          : winner === "You" ? `You take round ${match.round}` : `${winner} takes round ${match.round}`;
        break;
      }
    }
    return shown;
  }
}
