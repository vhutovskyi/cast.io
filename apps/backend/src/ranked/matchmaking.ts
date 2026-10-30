import { searchWindow } from "../shared/ranked.js";

/** A player searching for a ranked match. */
export interface Searching {
  id: string;
  rating: number;
  /** Wall-clock ms they started searching. */
  queuedAt: number;
}

/**
 * Who to pair up right now. Longest waiting first, each is paired with the
 * closest-rated player still free whose window and theirs both reach the
 * other (ties go to whoever has waited longer). Everyone else keeps
 * searching, their windows a little wider next time.
 */
export function pairQueue<T extends Searching>(queue: readonly T[], now: number): [T, T][] {
  const byWait = [...queue].sort((a, b) => a.queuedAt - b.queuedAt);
  const free = new Set(byWait);
  const pairs: [T, T][] = [];

  for (const player of byWait) {
    if (!free.has(player)) { continue; }
    const reach = searchWindow(now - player.queuedAt);

    let best: T | undefined;
    let bestGap = Infinity;
    for (const other of free) {
      if (other === player) { continue; }
      const gap = Math.abs(player.rating - other.rating);
      // `free` keeps `byWait`'s order, so the first at a given gap has waited longest.
      if (gap < bestGap && gap <= reach && gap <= searchWindow(now - other.queuedAt)) {
        best = other;
        bestGap = gap;
      }
    }
    if (best) {
      free.delete(player);
      free.delete(best);
      pairs.push([player, best]);
    }
  }
  return pairs;
}
