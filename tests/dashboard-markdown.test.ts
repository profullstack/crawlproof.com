import { describe, it, expect } from "vitest";
import { renderToScreen } from "@profullstack/hqtui/testing";
import { dashboardMarkdownContext, initialState, renderBody, type State } from "@/cli/dashboard";
import { buildRoi } from "@/lib/dashboard/roi";

function state(): State {
  const finance = { errors: { payouts: "Failed to fetch payouts" }, windowDays: 30 };
  return initialState({ range: "1m", snapshot: {
    generatedAt: "2026-09-13T12:00:00Z",
    window: { range: "1m", who: "humans", financeDays: 30 },
    sites: [], fleet: { sources: [], pages: [], referrers: [] },
    ads: null, finance, errors: { finance: "1 CoinPay sources unavailable" },
    adsStale: true, adsUpdatedAt: "2026-09-12T12:00:00Z",
    roi: buildRoi({ traffic: { range: "1m", who: "humans", sites: [] }, ads: null, finance }),
  } });
}

const draw = (s: State) => renderToScreen(({ ui, theme }) => renderBody(ui, s, theme), {
  width: 160, height: 44, copyMarkdown: true, markdownContext: dashboardMarkdownContext(s),
});

describe("dashboard Markdown copy", () => {
  it("copies exact feed errors, displayed/requested ranges, timestamps and stale warnings", () => {
    const s = state();
    s.range = "1w";
    s.who = "bots";
    s.loading = true;
    s.feeds.finance = { status: "error", detail: "1 CoinPay sources unavailable" };
    const screen = draw(s);
    const icon = screen.find("⧉ MD")!;
    expect(icon).not.toBeNull();
    screen.click(icon.x, icon.y);
    const text = screen.copied[0];
    expect(text).toContain("## CrawlProof status");
    expect(text).toContain("Displayed range: 1m · humans");
    expect(text).toContain("Requested range: 1w · bots (refresh pending)");
    expect(text).toContain("CoinPay window: 30 days");
    expect(text).toContain("CoinPay payouts: Failed to fetch payouts");
    expect(text).toContain("Ads are stale: last successful read 2026-09-12T12:00:00Z");
  });

  it("makes ROI summaries independently copyable with caveats", () => {
    const screen = draw(state());
    for (const r of screen.regions) screen.click(r.rect.x, r.rect.y);
    const summary = screen.copied.find((text) => text.startsWith("## The number"));
    expect(summary).toBeDefined();
    expect(summary).toContain("CrawlProof · Fleet · ROI");
    expect(summary).toContain("Snapshot: 2026-09-13T12:00:00Z");
    expect(summary).toContain("CoinPay payouts: Failed to fetch payouts");
    expect(screen.copied.some((text) => text.startsWith("## Read this before quoting a number"))).toBe(true);
  });

  it("lets startup and failed refresh status be copied before a snapshot arrives", () => {
    const s = initialState({ error: "Not connected <retry>" });
    const screen = draw(s);
    const icon = screen.find("⧉ MD")!;
    screen.click(icon.x, icon.y);
    expect(screen.copied[0]).toContain("Snapshot: not loaded");
    expect(screen.copied[0]).toContain("Not connected \\<retry\\>");
  });
});
