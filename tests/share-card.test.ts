import { describe, it, expect } from "vitest";
import { buildShareCard, hostOf, type ShareCardAudit } from "@/lib/audit/share-card";

function audit(over: Partial<ShareCardAudit> = {}): ShareCardAudit {
  return {
    target_url: "https://www.acme.com/",
    status: "complete",
    score: 72,
    engine: "rule",
    summary: { pagesCrawled: 12, pass: 20, warn: 3, fail: 5 },
    ...over,
  };
}

describe("hostOf", () => {
  it("strips protocol and www", () => {
    expect(hostOf("https://www.acme.com/pricing?x=1")).toBe("acme.com");
  });

  it("falls back to something renderable for a malformed URL", () => {
    // A card with no hostname at all is worse than a best-effort one.
    expect(hostOf("acme.com/pricing")).toBe("acme.com");
    expect(hostOf("not a url")).toBe("not a url");
  });
});

describe("buildShareCard — AEO engine", () => {
  it("reads the score from audits.score", () => {
    const card = buildShareCard(audit({ score: 72 }));
    expect(card.kind).toBe("aeo");
    expect(card.label).toBe("AEO Score");
    expect(card.score).toBe(72);
    expect(card.host).toBe("acme.com");
  });

  it("runs the conventional direction — high is good", () => {
    expect(buildShareCard(audit({ score: 92 })).tone).toBe("pass");
    expect(buildShareCard(audit({ score: 65 })).tone).toBe("warn");
    expect(buildShareCard(audit({ score: 20 })).tone).toBe("fail");
  });

  it("leads with failures when there are any", () => {
    expect(buildShareCard(audit()).headline).toBe("5 checks failed · 12 pages crawled");
  });

  it("leads with passes on a clean scan", () => {
    const card = buildShareCard(audit({ summary: { pagesCrawled: 1, pass: 28, fail: 0 } }));
    expect(card.headline).toBe("all 28 checks passed · 1 page crawled");
  });
});

describe("buildShareCard — slop engine", () => {
  const slop = (over: Partial<ShareCardAudit> = {}) =>
    audit({
      engine: "slop",
      // audits.score holds the AEO-style derived score; the headline number
      // for a slop scan is summary.slopScore, and they differ.
      score: 78,
      summary: {
        pagesCrawled: 50,
        slopScore: 34,
        slopGrade: "Careless",
        slopIssues: 37,
      },
      ...over,
    });

  it("reads summary.slopScore, not audits.score", () => {
    const card = buildShareCard(slop());
    expect(card.kind).toBe("slop");
    expect(card.label).toBe("Slop Score");
    // The regression this guards: showing 78 next to a card reading 34.
    expect(card.score).toBe(34);
  });

  it("inverts the dial — low is good", () => {
    expect(buildShareCard(slop({ summary: { slopScore: 10 } })).tone).toBe("pass");
    expect(buildShareCard(slop({ summary: { slopScore: 40 } })).tone).toBe("warn");
    expect(buildShareCard(slop({ summary: { slopScore: 90 } })).tone).toBe("fail");
  });

  it("scores the two engines in opposite directions for the same number", () => {
    // 90 is excellent AEO and terrible slop. Getting this backwards would
    // paint a badly-slopped site green on every social preview.
    expect(buildShareCard(audit({ score: 90 })).tone).toBe("pass");
    expect(buildShareCard(slop({ summary: { slopScore: 90 } })).tone).toBe("fail");
  });

  it("states the direction so a low number is not misread", () => {
    expect(buildShareCard(slop()).scaleHint).toBe("0 = pristine · 100 = maximum slop");
    expect(buildShareCard(audit()).scaleHint).toBe("out of 100 · higher is better");
  });

  it("builds the headline from grade, issues, and pages", () => {
    expect(buildShareCard(slop()).headline).toBe("Careless · 37 issues · 50 pages swept");
  });

  it("names the scan that actually ran in the footer", () => {
    // An "SEO · AEO · GEO audit" strapline under a Slop Score describes a
    // different product than the one that produced the number.
    expect(buildShareCard(slop()).footer).toBe("Free carelessness scan — content, code, design");
    expect(buildShareCard(audit()).footer).toBe("SEO · AEO · GEO audit — free, no signup");
    // Present on every state, not just complete.
    expect(buildShareCard(slop({ status: "failed" })).footer).toContain("carelessness");
  });

  it("detects a slop row whose engine column is null", () => {
    // Sibling rows in a multi-engine scan_run can carry a null engine.
    const card = buildShareCard(slop({ engine: null }));
    expect(card.kind).toBe("slop");
    expect(card.score).toBe(34);
  });
});

describe("buildShareCard — run states", () => {
  it("renders a pending card while the scan runs", () => {
    for (const status of ["queued", "running"]) {
      const card = buildShareCard(audit({ status, score: null }));
      expect(card.state).toBe("pending");
      expect(card.score).toBeNull();
      expect(card.headline).toBe("Scan running…");
      expect(card.tone).toBe("neutral");
    }
  });

  it("renders a failed card", () => {
    const card = buildShareCard(audit({ status: "failed", score: null }));
    expect(card.state).toBe("failed");
    expect(card.headline).toBe("Scan failed");
  });

  it("treats a complete row with no score as pending rather than showing null", () => {
    expect(buildShareCard(audit({ score: null })).state).toBe("pending");
  });
});

describe("buildShareCard — degraded rows", () => {
  it("never leaves the headline empty when summary keys are missing", () => {
    // Rows predating the slopScore/slopIssues summary keys still get a card.
    const card = buildShareCard(audit({ summary: {} }));
    expect(card.headline).toBe("See the full report");
  });

  it("tolerates a null summary", () => {
    const card = buildShareCard(audit({ summary: null }));
    expect(card.score).toBe(72);
    expect(card.headline).toBe("See the full report");
  });

  it("keeps the meter visible at a score of zero and clamps at 100", () => {
    expect(buildShareCard(audit({ score: 0 })).fill).toBe(2);
    expect(buildShareCard(audit({ score: 100 })).fill).toBe(100);
  });
});
