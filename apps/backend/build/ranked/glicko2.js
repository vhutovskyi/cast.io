/**
 * Glicko-2 (Glickman, "Example of the Glicko-2 system", 2013). Pure: the
 * caller decides when a rating period starts and what it holds.
 */
/** Converts between the Glicko scale (1500 ± 350) and Glicko-2's internal one. */
const SCALE = 173.7178;
const CENTRE = 1500;
/** Convergence tolerance of the volatility iteration. */
const EPSILON = 0.000001;
const g = (phi) => 1 / Math.sqrt(1 + 3 * phi * phi / (Math.PI * Math.PI));
const expected = (mu, muJ, phiJ) => 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));
/** Deviation after `periods` rating periods without a game, capped at `maxDeviation`. */
export function idleDeviation(player, periods, maxDeviation) {
    const phi = player.deviation / SCALE;
    return Math.min(maxDeviation, SCALE * Math.sqrt(phi * phi + Math.max(0, periods) * player.volatility * player.volatility));
}
/** `player`'s rating after a period with these games. No games: only the deviation grows. */
export function rate(player, games, { tau, maxDeviation, periods = 1 }) {
    if (games.length === 0) {
        return { ...player, deviation: idleDeviation(player, periods, maxDeviation) };
    }
    const mu = (player.rating - CENTRE) / SCALE;
    const phi = player.deviation / SCALE;
    const sigma = player.volatility;
    // Step 3–4: estimated variance from the games, and the estimated improvement.
    let vInverse = 0;
    let sum = 0;
    for (const { opponent, score } of games) {
        const muJ = (opponent.rating - CENTRE) / SCALE;
        const phiJ = opponent.deviation / SCALE;
        const e = expected(mu, muJ, phiJ);
        vInverse += g(phiJ) ** 2 * e * (1 - e);
        sum += g(phiJ) * (score - e);
    }
    const v = 1 / vInverse;
    const delta = v * sum;
    // Step 5: the new volatility, by the Illinois algorithm.
    const a = Math.log(sigma * sigma);
    const f = (x) => {
        const ex = Math.exp(x);
        return ex * (delta * delta - phi * phi - v - ex) / (2 * (phi * phi + v + ex) ** 2) - (x - a) / (tau * tau);
    };
    let A = a;
    let B;
    if (delta * delta > phi * phi + v) {
        B = Math.log(delta * delta - phi * phi - v);
    }
    else {
        let k = 1;
        while (f(a - k * tau) < 0) {
            k++;
        }
        B = a - k * tau;
    }
    let fA = f(A);
    let fB = f(B);
    while (Math.abs(B - A) > EPSILON) {
        const C = A + (A - B) * fA / (fB - fA);
        const fC = f(C);
        if (fC * fB <= 0) {
            A = B;
            fA = fB;
        }
        else {
            fA /= 2;
        }
        B = C;
        fB = fC;
    }
    const volatility = Math.exp(A / 2);
    // Step 6–7: grow the deviation over the time away, then fold in the games.
    const phiStar = Math.min(maxDeviation / SCALE, Math.sqrt(phi * phi + Math.max(0, periods) * volatility * volatility));
    const phiNew = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
    const muNew = mu + phiNew * phiNew * sum;
    return { rating: CENTRE + SCALE * muNew, deviation: SCALE * phiNew, volatility };
}
