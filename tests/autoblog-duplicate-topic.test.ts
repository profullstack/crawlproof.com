import { describe, it, expect } from "vitest";
import { findPublishedTopic } from "@/lib/lx/articleGen";

// threatcrush.com, 2026-10: one keyword came back to the queue and was
// published fifteen times as ci-cd-security-threat-detection-2 … -c7w1.
const existing = [
  { slug: "ci-cd-security-threat-detection", title: "CI/CD Security Threat Detection: An Operational Architecture for the SOC" },
  { slug: "detection-engineering-pricing", title: "Detection Engineering Pricing in 2026: A Practical Cost and Architecture Guide" },
];

describe("findPublishedTopic", () => {
  it("finds the topic from the keyword alone", () => {
    expect(findPublishedTopic(existing, { slugs: ["ci-cd-security-threat-detection"], heads: ["ci/cd security threat detection"] }))
      .toBe("ci-cd-security-threat-detection");
  });

  it("treats a collision-suffixed slug as the same topic", () => {
    for (const slug of ["ci-cd-security-threat-detection-2", "ci-cd-security-threat-detection-hl4w"]) {
      expect(findPublishedTopic(existing, { slugs: [slug], heads: ["Something else"] }), slug).toBe("ci-cd-security-threat-detection");
    }
  });

  it("catches a new slug whose title only reframes the subtitle", () => {
    expect(findPublishedTopic(existing, {
      slugs: ["ci-cd-security-threat-detection-operational-architecture"],
      heads: ["CI/CD Security Threat Detection: An Operating Model for the Modern SOC"],
    })).toBe("ci-cd-security-threat-detection");
  });

  it("lets a genuinely different angle on a related keyword through", () => {
    expect(findPublishedTopic(existing, { slugs: ["detection-engineering-metrics"], heads: ["Detection Engineering Metrics That Matter"] })).toBeNull();
    expect(findPublishedTopic(existing, { slugs: ["detection-engineering-framework"], heads: ["detection engineering framework"] })).toBeNull();
  });
});
