import { describe, expect, it } from "vitest";
import { parseCampaignPatch, parseCampaignRequest } from "@/lib/ads/campaign-request";

// Autobid is the default and the only thing most callers see. A bid sent on
// its own means "keep this bid", so it turns autobid off; saying `autobid`
// explicitly wins either way.

describe("parseCampaignRequest and autobid", () => {
  it("says nothing about autobid when nothing was sent (the column default is on)", () => {
    const r = parseCampaignRequest({ url: "https://example.com" });
    expect(r.ok && r.request.autobid).toBeUndefined();
  });

  it("turns autobid off when a bid is sent without saying otherwise", () => {
    const r = parseCampaignRequest({ url: "https://example.com", bid_credits: 6 });
    expect(r.ok && r.request).toMatchObject({ bidCredits: 6, autobid: false });
  });

  it("keeps autobid on when asked, even beside a bid", () => {
    const r = parseCampaignRequest({ url: "https://example.com", bid_credits: 6, autobid: true });
    expect(r.ok && r.request).toMatchObject({ bidCredits: 6, autobid: true });
  });

  it("reads autobid as a shell would send it", () => {
    const r = parseCampaignRequest({ url: "https://example.com", autobid: "false" });
    expect(r.ok && r.request.autobid).toBe(false);
  });
});

describe("parseCampaignPatch and autobid", () => {
  it("accepts autobid alone as a change", () => {
    const r = parseCampaignPatch({ autobid: true });
    expect(r).toEqual({ ok: true, patch: { autobid: true } });
  });

  it("a typed bid turns autobid off", () => {
    const r = parseCampaignPatch({ bid_credits: 9 });
    expect(r).toEqual({ ok: true, patch: { bidCredits: 9, autobid: false } });
  });

  it("names autobid among the fields when nothing was sent", () => {
    const r = parseCampaignPatch({});
    expect(!r.ok && r.error).toMatch(/autobid/);
  });
});
