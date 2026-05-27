import { describe, expect, it } from "vitest";
import {
  BUYER_JOURNEY_KEYWORD_INSTRUCTIONS,
  BUYER_JOURNEY_KEYWORD_JSON_SCHEMA,
  BuyerJourneyKeywordOutput,
  buildBuyerJourneyKeywordPrompt,
  flattenBuyerJourneyKeywords,
} from "@/lib/lx/buyerJourneyKeywords";

describe("buyer journey keyword research", () => {
  it("pins the interruption strategy in the model instructions", () => {
    expect(BUYER_JOURNEY_KEYWORD_INSTRUCTIONS).toContain(
      "go beyond synonyms",
    );
    expect(BUYER_JOURNEY_KEYWORD_INSTRUCTIONS).toContain(
      "underlying problem",
    );
    expect(BUYER_JOURNEY_KEYWORD_INSTRUCTIONS).toContain(
      "pricing",
    );
    expect(BUYER_JOURNEY_KEYWORD_INSTRUCTIONS).toContain(
      "Do not generate misleading",
    );
  });

  it("builds the API input template with product and audience context", () => {
    const prompt = buildBuyerJourneyKeywordPrompt({
      seedQuery: "why is my brand not showing in ai search",
      additionalSeeds: ["aeo audit", "gptbot checker"],
      offer: "CrawlProof, an AEO audit tool",
      audience: "founders, marketers, SEO consultants",
      brand: "CrawlProof",
      geography: "United States",
      industry: "AI search optimization",
      competitors: ["schema validators", "robots.txt testers"],
      tone: "helpful, educational, non-pushy",
    });

    expect(prompt).toContain("Seed query: why is my brand not showing in ai search");
    expect(prompt).toContain("Product or service to promote: CrawlProof");
    expect(prompt).toContain("Known competitors or substitutes");
    expect(prompt).toContain("Generate buyer-journey interruption keyword opportunities.");
  });

  it("flattens and deduplicates clustered keyword opportunities by priority", () => {
    const parsed = BuyerJourneyKeywordOutput.parse({
      seed_query: "why is my brand not showing in ai search",
      assumed_solution: "AI search optimization",
      underlying_problem: "answer engines cannot discover the site",
      searcher_stage: "mixed",
      openness_signals: ["checker", "template", "why"],
      keyword_clusters: [
        {
          cluster_name: "Technical access",
          cluster_type: "problem_aware",
          why_it_matters: "The buyer may need crawler access fixes.",
          keywords: [
            {
              keyword: "Can ChatGPT read my website",
              intent: "informational",
              priority: 5,
              content_angle: "Explain crawler access checks.",
              soft_product_pivot: "Mention an audit as one diagnostic path.",
            },
            {
              keyword: "https://example.com/bad",
              intent: "navigational",
              priority: 5,
              content_angle: "Bad URL-like keyword.",
              soft_product_pivot: "Skip.",
            },
          ],
        },
        {
          cluster_name: "Templates",
          cluster_type: "diy_or_template",
          why_it_matters: "DIY searchers can still need validation.",
          keywords: [
            {
              keyword: "llms.txt template",
              intent: "informational",
              priority: 4,
              content_angle: "Offer a practical template.",
              soft_product_pivot: "Suggest checking whether answer engines can read it.",
            },
            {
              keyword: "can chatgpt read my website",
              intent: "informational",
              priority: 3,
              content_angle: "Duplicate should be removed.",
              soft_product_pivot: "Skip duplicate.",
            },
          ],
        },
      ],
      recommended_content_assets: [],
      ethical_notes: ["Do not imply guaranteed AI answer inclusion."],
    });

    expect(flattenBuyerJourneyKeywords(parsed)).toEqual([
      expect.objectContaining({
        keyword: "can chatgpt read my website",
        priority: 5,
        clusterType: "problem_aware",
      }),
      expect.objectContaining({
        keyword: "llms.txt template",
        priority: 4,
        clusterType: "diy_or_template",
      }),
    ]);
  });

  it("exposes a strict JSON schema for Responses API structured outputs", () => {
    expect(BUYER_JOURNEY_KEYWORD_JSON_SCHEMA).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        keyword_clusters: {
          type: "array",
        },
      },
    });
  });
});
