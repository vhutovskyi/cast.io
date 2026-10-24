import assert from "assert";
import { InputPacer, type InputQueue, MAX_BACKLOG, MAX_TARGET, MIN_TARGET, SHRINK_AFTER_TICKS } from "../src/rooms/inputPacer.js";

/** A plain FIFO standing in for a client's input buffer. */
function queue(): InputQueue<number> & { push(...items: number[]): void } {
  const items: number[] = [];
  return {
    get size() { return items.length; },
    next: () => items.shift(),
    take: (n: number) => items.splice(0, n),
    push: (...more: number[]) => { items.push(...more); },
  };
}

describe("InputPacer", () => {
  it("hands out one input per tick when they arrive steadily", () => {
    const pacer = new InputPacer();
    const q = queue();
    for (let tick = 0; tick < 10; tick++) {
      q.push(tick);
      assert.deepStrictEqual(pacer.take("a", q), [tick]);
    }
  });

  it("spreads a burst over several ticks instead of applying it at once", () => {
    const pacer = new InputPacer();
    const q = queue();
    q.push(1, 2, 3, 4, 5, 6);

    const perTick: number[][] = [];
    while (q.size > 0) { perTick.push(pacer.take("a", q)); }

    assert.ok(perTick.every((taken) => taken.length <= 2), "never more than two per tick");
    assert.deepStrictEqual(perTick.flat(), [1, 2, 3, 4, 5, 6], "all applied, in order");
  });

  it("deepens the cushion after running dry, then waits a bounded time to refill", () => {
    const pacer = new InputPacer();
    const q = queue();
    q.push(1);
    assert.deepStrictEqual(pacer.take("a", q), [1]);

    assert.deepStrictEqual(pacer.take("a", q), [], "starved");
    assert.strictEqual(pacer.targetOf("a"), MIN_TARGET + 1);

    q.push(2);
    assert.deepStrictEqual(pacer.take("a", q), [], "refilling the cushion");
    assert.deepStrictEqual(pacer.take("a", q), [2], "but not waiting forever on a lone input");
  });

  it("eases the cushion back down after a calm stretch, never below the minimum", () => {
    const pacer = new InputPacer();
    const q = queue();
    q.push(0);
    pacer.take("a", q);
    pacer.take("a", q); // starve once: target 2

    for (let tick = 0; tick < SHRINK_AFTER_TICKS + 2; tick++) {
      q.push(tick);
      pacer.take("a", q);
    }
    assert.strictEqual(pacer.targetOf("a"), MIN_TARGET);
  });

  it("caps the cushion and drops a stale backlog rather than replaying it", () => {
    const pacer = new InputPacer();
    const q = queue();
    for (let i = 0; i < 20; i++) { q.push(i); pacer.take("a", q); pacer.take("a", q); }
    assert.ok(pacer.targetOf("a") <= MAX_TARGET);

    const backlog = queue();
    backlog.push(...Array.from({ length: MAX_BACKLOG + 5 }, (_, i) => i));
    const taken = new InputPacer().take("b", backlog);
    assert.ok(taken[0] >= 5, "the oldest inputs past the backlog limit were dropped");
  });

  it("tracks players independently and forgets those who leave", () => {
    const pacer = new InputPacer();
    const q = queue();
    q.push(1);
    pacer.take("a", q);
    pacer.take("a", q);
    assert.strictEqual(pacer.targetOf("a"), MIN_TARGET + 1);
    assert.strictEqual(pacer.targetOf("b"), MIN_TARGET);

    pacer.remove("a");
    assert.strictEqual(pacer.targetOf("a"), MIN_TARGET);
  });
});
