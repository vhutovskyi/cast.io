import assert from "assert";
import { pairQueue } from "../src/ranked/matchmaking.js";
import { RANKED, searchWindow } from "../src/shared/ranked.js";

describe("ranked matchmaking", () => {
  const ids = (pairs: { id: string }[][]) => pairs.map((pair) => pair.map((p) => p.id));

  it("widens the search window with time waited, up to a cap", () => {
    const { baseRating, perSecond, maxRating } = RANKED.window;
    assert.strictEqual(searchWindow(0), baseRating);
    assert.strictEqual(searchWindow(-5000), baseRating, "clock skew never narrows it");
    assert.strictEqual(searchWindow(10_000), baseRating + 10 * perSecond);
    assert.strictEqual(searchWindow(1e9), maxRating);
  });

  it("pairs players within each other's window", () => {
    const now = 100_000;
    const pairs = pairQueue([
      { id: "a", rating: 1500, queuedAt: now },
      { id: "b", rating: 1550, queuedAt: now },
    ], now);
    assert.deepStrictEqual(ids(pairs), [["a", "b"]]);
  });

  it("keeps far-apart players searching until both windows reach", () => {
    const start = 100_000;
    const queue = [
      { id: "a", rating: 1500, queuedAt: start },
      { id: "b", rating: 1800, queuedAt: start },
    ];
    assert.deepStrictEqual(pairQueue(queue, start), []);
    // 300 apart: each window must reach 300, i.e. 20 s at 10 points a second.
    assert.deepStrictEqual(pairQueue(queue, start + 19_000), []);
    assert.deepStrictEqual(ids(pairQueue(queue, start + 20_000)), [["a", "b"]]);
  });

  it("needs both windows: a long wait doesn't drag in a player who just started", () => {
    const now = 100_000;
    const queue = [
      { id: "veteran", rating: 1500, queuedAt: now - 60_000 },
      { id: "newcomer", rating: 1800, queuedAt: now },
    ];
    assert.deepStrictEqual(pairQueue(queue, now), []);
  });

  it("serves the longest wait first, with the closest rating", () => {
    const now = 100_000;
    const pairs = pairQueue([
      { id: "near", rating: 1520, queuedAt: now },
      { id: "first", rating: 1500, queuedAt: now - 5_000 },
      { id: "nearer", rating: 1505, queuedAt: now },
      { id: "far", rating: 1580, queuedAt: now },
    ], now);
    assert.deepStrictEqual(ids(pairs), [["first", "nearer"], ["near", "far"]]);
  });

  it("breaks a tie in rating gap towards whoever has waited longer", () => {
    const now = 100_000;
    const pairs = pairQueue([
      { id: "me", rating: 1500, queuedAt: now - 9_000 },
      { id: "fresh", rating: 1540, queuedAt: now },
      { id: "patient", rating: 1460, queuedAt: now - 3_000 },
    ], now);
    assert.deepStrictEqual(ids(pairs), [["me", "patient"]]);
  });

  it("leaves an odd one out", () => {
    const now = 100_000;
    const queue = ["a", "b", "c"].map((id) => ({ id, rating: 1500, queuedAt: now }));
    assert.strictEqual(pairQueue(queue, now).length, 1);
    assert.deepStrictEqual(pairQueue([], now), []);
  });
});
