import { afterEach, describe, expect, it, vi } from "vitest";
import { runAuction, type BidCandidate } from "@/lib/ads/auction";

// runAuction is a bid-weighted lottery over Math.random(). We stub Math.random
// so every "where did the cursor land" case is deterministic, then add one
// fully-deterministic distribution sweep to prove proportionality.

afterEach(() => {
  vi.restoreAllMocks();
});

function stubRandom(...values: number[]) {
  let i = 0;
  vi.spyOn(Math, "random").mockImplementation(() => values[i++ % values.length]);
}

const cand = (bidCredits: number, item: string): BidCandidate<string> => ({
  bidCredits,
  item,
});

describe("runAuction — bid-weighted lottery", () => {
  it("returns null when there are no candidates", () => {
    expect(runAuction([])).toBeNull();
  });

  it("always returns the sole candidate", () => {
    stubRandom(0, 0.5, 0.999);
    for (let i = 0; i < 3; i++) {
      expect(runAuction([cand(5, "only")])).toEqual({ winner: "only", bidCredits: 5 });
    }
  });

  it("picks by cumulative weight — r lands in the first bucket", () => {
    // bids [1, 3] => weights [1, 3], total 4. r = 0 * 4 = 0 => first bucket.
    stubRandom(0);
    expect(runAuction([cand(1, "a"), cand(3, "b")])?.winner).toBe("a");
  });

  it("picks by cumulative weight — r crosses into a later bucket", () => {
    // total 4, r = 0.5 * 4 = 2. a's weight 1 leaves 1; b's weight 3 crosses => b.
    stubRandom(0.5);
    const res = runAuction([cand(1, "a"), cand(3, "b")]);
    expect(res).toEqual({ winner: "b", bidCredits: 3 });
  });

  it("gives a zero-bid campaign a nonzero chance via the weight floor", () => {
    // Two zero bids => both floored to MIN_WEIGHT, so each still wins ~half.
    // r near 0 => first, r near the top => second. Neither is starved.
    stubRandom(0);
    expect(runAuction([cand(0, "x"), cand(0, "y")])?.winner).toBe("x");
    stubRandom(0.99);
    expect(runAuction([cand(0, "x"), cand(0, "y")])?.winner).toBe("y");
  });

  it("still rotates a zero-bid alongside a real bid", () => {
    // bids [0, 10] => weights [0.001, 10], total 10.001.
    // A tiny r selects the zero-bid campaign — it is not permanently starved.
    stubRandom(0);
    expect(runAuction([cand(0, "zero"), cand(10, "paid")])?.winner).toBe("zero");
    // A mid r selects the paid campaign, as expected for the dominant weight.
    stubRandom(0.5);
    expect(runAuction([cand(0, "zero"), cand(10, "paid")])?.winner).toBe("paid");
  });

  it("awards the last candidate when float rounding leaves the cursor unspent", () => {
    // Math.random() === 1 (only reachable via the stub) makes r === total, so
    // the subtraction loop never crosses zero and the guard fires.
    stubRandom(1);
    const res = runAuction([cand(2, "a"), cand(2, "b"), cand(2, "c")]);
    expect(res).toEqual({ winner: "c", bidCredits: 2 });
  });

  it("distributes wins proportionally to bid over a deterministic r-sweep", () => {
    // Sweep r-fractions evenly across [0,1); higher bid should win ~9x as often.
    const N = 1000;
    const counts: Record<string, number> = { low: 0, high: 0 };
    for (let i = 0; i < N; i++) {
      vi.spyOn(Math, "random").mockReturnValue(i / N);
      const winner = runAuction([cand(1, "low"), cand(9, "high")])?.winner;
      if (winner) counts[winner]++;
      vi.restoreAllMocks();
    }
    // Weights 1:9 => low ~10% (100), high ~90% (900).
    expect(counts.low).toBe(100);
    expect(counts.high).toBe(900);
  });
});
