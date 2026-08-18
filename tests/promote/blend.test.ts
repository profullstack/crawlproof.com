import { describe, it, expect } from "vitest";
import {
  chooseOwnership,
  parseFallback,
  parseMix,
  rankByDeficit,
  DEFAULT_MIX,
  type BlendMix,
  type FallbackPolicy,
  type Ownership,
} from "@/lib/promote/blend";

const allAvailable = { owned: true, partner: true, shared: true };

const permissive: FallbackPolicy = {
  whenOwnedQueueEmpty: "use_shared",
  whenSharedQueueEmpty: "use_owned",
  maxFallbackItemsPerDay: null,
};

describe("parseMix", () => {
  it("reads a stored mix", () => {
    expect(parseMix({ owned: 70, shared: 30 })).toEqual({ owned: 70, partner: 0, shared: 30 });
  });

  it("falls back to the default when nothing is weighted", () => {
    expect(parseMix({ owned: 0, shared: 0 })).toEqual(DEFAULT_MIX);
    expect(parseMix(null)).toEqual(DEFAULT_MIX);
    expect(parseMix("nonsense")).toEqual(DEFAULT_MIX);
  });

  it("ignores negative and non-numeric weights", () => {
    expect(parseMix({ owned: -5, shared: "x", partner: 10 })).toEqual({
      owned: 0,
      partner: 10,
      shared: 0,
    });
  });
});

describe("parseFallback", () => {
  it("keeps a valid policy", () => {
    expect(
      parseFallback({
        whenOwnedQueueEmpty: "pause",
        whenSharedQueueEmpty: "use_any_available",
        maxFallbackItemsPerDay: 5,
      }),
    ).toEqual({
      whenOwnedQueueEmpty: "pause",
      whenSharedQueueEmpty: "use_any_available",
      maxFallbackItemsPerDay: 5,
    });
  });

  it("preserves an explicit null cap as unlimited", () => {
    expect(parseFallback({ maxFallbackItemsPerDay: null }).maxFallbackItemsPerDay).toBeNull();
  });

  it("repairs unknown actions", () => {
    expect(parseFallback({ whenOwnedQueueEmpty: "explode" }).whenOwnedQueueEmpty).toBe(
      "use_shared",
    );
  });
});

describe("chooseOwnership", () => {
  const mix: BlendMix = { owned: 70, partner: 0, shared: 30 };

  it("opens a fresh list with the dominant class", () => {
    const decision = chooseOwnership({
      mix,
      posted: {},
      available: allAvailable,
      fallback: permissive,
    });
    expect(decision.ownership).toBe("owned");
    expect(decision.viaFallback).toBe(false);
    expect(decision.reason).toBe("on_target");
  });

  it("switches to the starved class once the leader is ahead of target", () => {
    // 8 owned / 0 shared against a 70/30 target: shared is furthest behind.
    const decision = chooseOwnership({
      mix,
      posted: { owned: 8, shared: 0 },
      available: allAvailable,
      fallback: permissive,
    });
    expect(decision.ownership).toBe("shared");
  });

  it("never draws from a class with no weight when the blend is satisfiable", () => {
    const decision = chooseOwnership({
      mix,
      posted: {},
      available: allAvailable,
      fallback: permissive,
    });
    expect(decision.ownership).not.toBe("partner");
  });

  describe("when the owned queue is empty", () => {
    const available = { owned: false, shared: true };

    it("uses shared content by default, flagged as a fallback", () => {
      const decision = chooseOwnership({ mix, posted: {}, available, fallback: permissive });
      expect(decision.ownership).toBe("shared");
      expect(decision.viaFallback).toBe(true);
      expect(decision.reason).toBe("fallback");
    });

    it("posts nothing when the policy says pause", () => {
      const decision = chooseOwnership({
        mix,
        posted: {},
        available,
        fallback: { ...permissive, whenOwnedQueueEmpty: "pause" },
      });
      expect(decision.ownership).toBeNull();
      expect(decision.reason).toBe("fallback_disabled");
    });

    it("stops once the daily fallback cap is reached", () => {
      const fallback = { ...permissive, maxFallbackItemsPerDay: 3 };
      expect(
        chooseOwnership({ mix, posted: {}, available, fallback, fallbackUsedToday: 2 })
          .ownership,
      ).toBe("shared");
      const capped = chooseOwnership({
        mix,
        posted: {},
        available,
        fallback,
        fallbackUsedToday: 3,
      });
      expect(capped.ownership).toBeNull();
      expect(capped.reason).toBe("fallback_cap_reached");
    });

    it("does not count against the cap when the target class is available", () => {
      const decision = chooseOwnership({
        mix,
        posted: {},
        available: allAvailable,
        fallback: { ...permissive, maxFallbackItemsPerDay: 0 },
        fallbackUsedToday: 99,
      });
      expect(decision.ownership).toBe("owned");
      expect(decision.viaFallback).toBe(false);
    });
  });

  it("falls back to owned when the shared queue is empty", () => {
    const decision = chooseOwnership({
      mix,
      posted: { owned: 9, shared: 0 },
      available: { owned: true, shared: false },
      fallback: permissive,
    });
    expect(decision.ownership).toBe("owned");
    expect(decision.viaFallback).toBe(true);
  });

  it("reaches an unweighted class only under use_any_available", () => {
    const onlyPartner = { owned: false, shared: false, partner: true };
    expect(
      chooseOwnership({ mix, posted: {}, available: onlyPartner, fallback: permissive })
        .ownership,
    ).toBeNull();
    expect(
      chooseOwnership({
        mix,
        posted: {},
        available: onlyPartner,
        fallback: { ...permissive, whenOwnedQueueEmpty: "use_any_available" },
      }).ownership,
    ).toBe("partner");
  });

  it("posts nothing when no class has inventory", () => {
    const decision = chooseOwnership({
      mix,
      posted: {},
      available: {},
      fallback: permissive,
    });
    expect(decision.ownership).toBeNull();
    expect(decision.reason).toBe("no_inventory");
  });
});

describe("rankByDeficit", () => {
  it("puts the class furthest below its target first", () => {
    const mix: BlendMix = { owned: 70, partner: 0, shared: 30 };
    expect(rankByDeficit(mix, { owned: 10, shared: 0 })[0]).toBe("shared");
    expect(rankByDeficit(mix, { owned: 0, shared: 10 })[0]).toBe("owned");
  });

  it("omits classes with no weight", () => {
    expect(rankByDeficit({ owned: 100, partner: 0, shared: 0 }, {})).toEqual(["owned"]);
  });
});

describe("convergence — the acceptance criterion", () => {
  // "A campaign can maintain a configured owned/shared publishing ratio."
  // Simulate a campaign with unlimited inventory on both sides and check the
  // realised ratio, which is what a user actually sees on their timeline.
  function simulate(mix: BlendMix, ticks: number): Record<string, number> {
    const posted: Partial<Record<Ownership, number>> = {};
    for (let i = 0; i < ticks; i++) {
      const decision = chooseOwnership({
        mix,
        posted,
        available: allAvailable,
        fallback: permissive,
      });
      const key = decision.ownership!;
      posted[key] = (posted[key] ?? 0) + 1;
    }
    return posted as Record<string, number>;
  }

  it("converges on 70/30", () => {
    const posted = simulate({ owned: 70, partner: 0, shared: 30 }, 100);
    expect(posted.owned).toBe(70);
    expect(posted.shared).toBe(30);
  });

  it("converges on 50/50", () => {
    const posted = simulate({ owned: 50, partner: 0, shared: 50 }, 100);
    expect(posted.owned).toBe(50);
    expect(posted.shared).toBe(50);
  });

  it("converges on a three-way split", () => {
    const posted = simulate({ owned: 50, partner: 20, shared: 30 }, 100);
    expect(posted.owned).toBe(50);
    expect(posted.partner).toBe(20);
    expect(posted.shared).toBe(30);
  });

  it("never produces a long run of one class", () => {
    // The failure mode weighted-random has: five shared posts in a row makes an
    // account read as a content farm.
    const mix: BlendMix = { owned: 70, partner: 0, shared: 30 };
    const posted: Partial<Record<Ownership, number>> = {};
    const sequence: Ownership[] = [];
    for (let i = 0; i < 60; i++) {
      const key = chooseOwnership({
        mix,
        posted,
        available: allAvailable,
        fallback: permissive,
      }).ownership!;
      posted[key] = (posted[key] ?? 0) + 1;
      sequence.push(key);
    }
    let longestRun = 1;
    let run = 1;
    for (let i = 1; i < sequence.length; i++) {
      run = sequence[i] === sequence[i - 1] ? run + 1 : 1;
      longestRun = Math.max(longestRun, run);
    }
    // 70/30 means owned legitimately posts twice in a row; four would be a bug.
    expect(longestRun).toBeLessThanOrEqual(3);
  });
});
