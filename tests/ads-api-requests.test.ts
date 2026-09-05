import { describe, expect, it } from "vitest";
import { parseCampaignRequest, domainOf } from "@/lib/ads/campaign-request";
import { parseSlotRequest, embedFor, hostOf, DEFAULT_UNIT_FORMAT } from "@/lib/ads/slots";
import { campaignBodyFromArgs, slotBodyFromArgs, parseArgs } from "@/cli/index";

describe("POST /api/ads/v1/campaigns body", () => {
  it("accepts a URL and applies the dashboard's clamps", () => {
    const parsed = parseCampaignRequest({ url: "https://nichedb.dev/i/17", name: " NicheDB ", daily_budget_cents: 250.4, bid_credits: 999 });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.url).toBe("https://nichedb.dev/i/17");
    expect(parsed.request).toEqual({ url: "https://nichedb.dev/i/17", name: "NicheDB", dailyBudgetCents: 250, bidCredits: 200 });
  });

  it("refuses what the audit target guard refuses, and a made-up status", () => {
    expect(parseCampaignRequest({ url: "http://localhost:3000/x" })).toMatchObject({ ok: false });
    expect(parseCampaignRequest({ url: "ftp://example.com" })).toMatchObject({ ok: false });
    expect(parseCampaignRequest({})).toMatchObject({ ok: false });
    expect(parseCampaignRequest({ url: "https://example.com", status: "paused" })).toMatchObject({ ok: false, error: expect.stringContaining("status") });
    expect(parseCampaignRequest({ url: "https://example.com", daily_budget_cents: -1 })).toMatchObject({ ok: false });
  });

  it("takes camelCase too, and a draft status", () => {
    const parsed = parseCampaignRequest({ url: "example.com", dailyBudgetCents: 100, status: "draft" });
    expect(parsed).toMatchObject({ ok: true, url: "https://example.com/", request: { dailyBudgetCents: 100, status: "draft" } });
  });

  it("domainOf strips www", () => {
    expect(domainOf("https://www.nichedb.dev/a")).toBe("nichedb.dev");
  });
});

describe("POST /api/ads/v1/slots body", () => {
  it("names the site by host, whether given a host or a URL", () => {
    expect(parseSlotRequest({ site: "nichedb.dev" })).toMatchObject({ ok: true, host: "nichedb.dev", request: { site: "nichedb.dev" } });
    expect(parseSlotRequest({ url: "https://www.nichedb.dev/blog/" })).toMatchObject({ ok: true, host: "nichedb.dev" });
    expect(hostOf("localhost")).toBeNull();
    expect(parseSlotRequest({ site: "" })).toMatchObject({ ok: false });
  });

  it("validates placement, formats and status", () => {
    expect(parseSlotRequest({ site: "x.dev", placement: "roof" })).toMatchObject({ ok: false, error: expect.stringContaining("placement") });
    expect(parseSlotRequest({ site: "x.dev", formats: "text_link, banner_728x90" })).toMatchObject({ ok: true, request: { formats: ["text_link", "banner_728x90"] } });
    expect(parseSlotRequest({ site: "x.dev", formats: ["<script>"] })).toMatchObject({ ok: false });
    expect(parseSlotRequest({ site: "x.dev", status: "paused" })).toMatchObject({ ok: false });
    expect(parseSlotRequest({ site: "x.dev", enable_tracking: false })).toMatchObject({ ok: true, request: { enableTracking: false } });
  });

  it("the embed is the unit, then the tracker, then the renderer", () => {
    const tags = embedFor("https://crawlproof.com/", "slot-1", "proj-1", DEFAULT_UNIT_FORMAT);
    expect(tags.tracker).toBe('<script data-site="proj-1" src="https://crawlproof.com/stats.js" async></script>');
    expect(tags.embed.split("\n")).toEqual([
      '<aside data-cp-ad data-slot="slot-1" data-format="text_link"></aside>',
      "",
      tags.tracker,
      '<script src="https://crawlproof.com/ad.js" async></script>',
    ]);
  });
});

describe("crawlproof ads / slots CLI", () => {
  it("builds the campaign body from its flags", () => {
    expect(campaignBodyFromArgs(parseArgs(["ads", "create", "https://nichedb.dev", "--name=NicheDB", "--budget=300", "--bid=5"]))).toEqual({
      url: "https://nichedb.dev",
      name: "NicheDB",
      daily_budget_cents: 300,
      bid_credits: 5,
      status: "active",
    });
    expect(campaignBodyFromArgs(parseArgs(["ads", "create", "https://x.dev", "--draft"]))).toEqual({ url: "https://x.dev", status: "draft" });
  });

  it("builds the slot body from its flags", () => {
    expect(slotBodyFromArgs(parseArgs(["slots", "create", "nichedb.dev", "--placement=footer", "--format=text_link", "--no-tracking"]))).toEqual({
      site: "nichedb.dev",
      placement: "footer",
      format: "text_link",
      enable_tracking: false,
    });
    expect(slotBodyFromArgs(parseArgs(["slots", "create", "x.dev", "--formats=a,b", "--inactive"]))).toEqual({ site: "x.dev", formats: ["a", "b"], status: "inactive" });
  });
});
