import assert from "assert";
import { idleDeviation, rate } from "../src/ranked/glicko2.js";

describe("Glicko-2", () => {
  const options = { tau: 0.5, maxDeviation: 350 };

  it("matches the worked example in Glickman's paper", () => {
    const player = { rating: 1500, deviation: 200, volatility: 0.06 };
    const next = rate(player, [
      { opponent: { rating: 1400, deviation: 30, volatility: 0.06 }, score: 1 },
      { opponent: { rating: 1550, deviation: 100, volatility: 0.06 }, score: 0 },
      { opponent: { rating: 1700, deviation: 300, volatility: 0.06 }, score: 0 },
    ], options);
    assert.ok(Math.abs(next.rating - 1464.06) < 0.01, `rating ${next.rating}`);
    assert.ok(Math.abs(next.deviation - 151.52) < 0.01, `deviation ${next.deviation}`);
    assert.ok(Math.abs(next.volatility - 0.05999) < 0.00001, `volatility ${next.volatility}`);
  });

  it("moves two equal players by the same amount, opposite ways", () => {
    const even = { rating: 1500, deviation: 350, volatility: 0.06 };
    const winner = rate(even, [{ opponent: even, score: 1 }], options);
    const loser = rate(even, [{ opponent: even, score: 0 }], options);
    assert.ok(winner.rating > 1500 && loser.rating < 1500);
    assert.ok(Math.abs((winner.rating - 1500) - (1500 - loser.rating)) < 1e-9);
    assert.ok(winner.deviation < 350, "a game makes the rating more certain");
  });

  it("an upset moves ratings more than the expected result", () => {
    const strong = { rating: 1800, deviation: 80, volatility: 0.06 };
    const weak = { rating: 1400, deviation: 80, volatility: 0.06 };
    const expected = rate(weak, [{ opponent: strong, score: 0 }], options);
    const upset = rate(weak, [{ opponent: strong, score: 1 }], options);
    assert.ok(upset.rating - weak.rating > weak.rating - expected.rating);
  });

  it("grows the deviation with time away, never past a newcomer's", () => {
    const settled = { rating: 1600, deviation: 50, volatility: 0.06 };
    assert.strictEqual(idleDeviation(settled, 0, 350), 50);
    const later = idleDeviation(settled, 30, 350);
    assert.ok(later > 50 && later < 350);
    assert.strictEqual(idleDeviation(settled, 1e6, 350), 350);
    assert.deepStrictEqual(rate(settled, [], { ...options, periods: 30 }), { ...settled, deviation: later }, "no games: only the deviation grows");
  });

  it("back-to-back games barely grow the deviation before the game counts", () => {
    const player = { rating: 1500, deviation: 100, volatility: 0.06 };
    const opponent = { rating: 1500, deviation: 100, volatility: 0.06 };
    const soon = rate(player, [{ opponent, score: 1 }], { ...options, periods: 0.001 });
    const aMonthLater = rate(player, [{ opponent, score: 1 }], { ...options, periods: 30 });
    assert.ok(soon.deviation < aMonthLater.deviation);
    assert.ok(soon.rating - 1500 < aMonthLater.rating - 1500, "a less certain rating moves further");
  });
});
