/** Everyone where they are now: no compensation (a server-driven attack, a test). */
export const LIVE = (player) => player;
/** `players` as a hit test reads them: alive or not as they are now, standing where `seen` has them. */
export function* seenPlayers(players, seen) {
    for (const [id, player] of players) {
        const { x, y, z } = seen(player);
        yield [id, { x, y, z, hp: player.hp }];
    }
}
