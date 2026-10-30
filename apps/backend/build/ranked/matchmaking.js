import { searchWindow } from "../shared/ranked.js";
/**
 * Who to pair up right now. Longest waiting first, each is paired with the
 * closest-rated player still free whose window and theirs both reach the
 * other (ties go to whoever has waited longer). Everyone else keeps
 * searching, their windows a little wider next time.
 */
export function pairQueue(queue, now) {
    const byWait = [...queue].sort((a, b) => a.queuedAt - b.queuedAt);
    const free = new Set(byWait);
    const pairs = [];
    for (const player of byWait) {
        if (!free.has(player)) {
            continue;
        }
        const reach = searchWindow(now - player.queuedAt);
        let best;
        let bestGap = Infinity;
        for (const other of free) {
            if (other === player) {
                continue;
            }
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
