/**
 * What the dashboard actually draws, and how you get from the list to a domain.
 *
 * Rendered rather than inspected: hqtui screens are only observable by drawing
 * them, and the two things that bite — a panel header that drops half of itself
 * at one width, and a table that is unreachable by the mouse because nothing
 * registered a hit region — are invisible in source review.
 *
 * The navigation is tested through `handleKey`, the same function the app binds
 * its key handler to, so what passes here is what the terminal does.
 */
import { describe, expect, it } from "vitest";
import { renderToScreen } from "@profullstack/hqtui/testing";

import { buildRoi } from "@/lib/dashboard/roi";
import { buildSiteDetail } from "@/lib/dashboard/site";
import type { DashboardSnapshot, SiteStats } from "@/lib/dashboard/collect";
import { handleKey, initialState, renderBody, scoreText, sortSites, type State } from "@/cli/dashboard";

const WIDE = { width: 160, height: 44 };

function siteRow(over: Partial<SiteStats> = {}): SiteStats {
  return {
    site: "nichedb.dev",
    id: "p-1",
    url: "https://nichedb.dev/",
    visitors: 400,
    pageviews: 120,
    sources: [
      { label: "Search · google", value: 70 },
      { label: "Direct", value: 30 },
    ],
    referrers: [{ label: "news.ycombinator.com", value: 9 }],
    pages: [{ label: "/pricing", value: 40 }],
    series: Array.from({ length: 8 }, (_, i) => ({
      date: `2026-09-0${i + 1}`,
      pageviews: 10 + i * 3,
      humans: 10 + i * 3,
      bots: 2,
      ai: 1,
    })),
    mix: { humans: 164, bots: 20, ai: 8, events: 184 },
    ...over,
  };
}

function snapshot(sites: SiteStats[]): DashboardSnapshot {
  const finance = {
    windowDays: 30,
    businesses: [{ id: "b-1", name: "coinpayportal.com" }],
    earnings: { commissionUsd: 500, grossVolumeUsd: 50_000 },
    series: Array.from({ length: 30 }, () => ({ volumeUsd: 100, commissionUsd: 1 })),
    position: {
      lookbackDays: 180,
      monthsObserved: 6,
      spending: { perMonth: 4_000 },
      scopes: [{ scope: "business", spending: 24_000, income: 600, accounts: 1 }],
    },
    bank: { accounts: [], ledger: [], ledgerTotal: 0 },
  };
  const ads = {
    rangeDays: 30,
    totals: { spentCents: 500, earnedCents: 700, pubImpressions: 9_000, pubClicks: 12 },
    slots: [{ id: "s-1", name: "nichedb.dev", projectId: "p-1", impressions: 900, clicks: 3, earnedCents: 250 }],
    campaigns: [{ id: "c-1", name: "NicheDB", url: "https://nichedb.dev/", spentCents: 120 }],
  };
  const roi = buildRoi({
    traffic: { range: "1m", who: "humans", sites },
    ads,
    finance,
  });
  const window = { range: "1m", who: "humans", financeDays: 30 };
  for (const site of sites) {
    site.score = buildSiteDetail({ site, roi, ads, finance, window }).score;
  }
  return {
    generatedAt: new Date().toISOString(),
    window,
    sites,
    fleet: { sources: sites[0]?.sources ?? [], referrers: [], pages: sites[0]?.pages ?? [] },
    ads,
    finance,
    roi,
    errors: {},
  };
}

function stateWith(over: Partial<State> = {}, sites: SiteStats[] = [siteRow()]): State {
  return initialState({ tab: 1, range: "1m", snapshot: snapshot(sites), ...over });
}

const draw = (state: State) =>
  renderToScreen(({ ui, theme }) => renderBody(ui, state, theme), WIDE);

describe("Traffic list", () => {
  it("draws a Score column beside the traffic, with the site's score in it", () => {
    const state = stateWith();
    const text = draw(state).text();
    expect(text).toContain("Score");
    expect(text).toContain("nichedb.dev");
    expect(text).toContain(scoreText(state.snapshot?.sites[0] as SiteStats));
  });

  it("says which order it is in and how to change it", () => {
    const text = draw(stateWith()).text();
    expect(text).toMatch(/by score/);
    expect(text).toMatch(/Enter opens/);
  });

  it("registers a mouse region, so a click can reach a row at all", () => {
    const screen = draw(stateWith());
    expect(screen.regions.length).toBeGreaterThan(0);
    expect(screen.regions.some((r) => typeof r.onClick === "function")).toBe(true);
  });

  it("marks a site that did not answer rather than drawing it as a quiet one", () => {
    const rows = [siteRow(), siteRow({ site: "down.dev", id: "p-2", url: "https://down.dev", error: "504 Gateway Timeout", visitors: 0, pageviews: 0, series: [], mix: undefined })];
    const text = draw(stateWith({}, rows)).text();
    expect(text).toContain("504");
    expect(text).toContain("down.dev");
  });
});

describe("sortSites", () => {
  const rows = () => [
    siteRow({ site: "busy.dev", id: "p-2", url: "https://busy.dev", visitors: 90_000, pageviews: 12 }),
    siteRow(),
    siteRow({ site: "dead.dev", id: "p-3", url: "https://dead.dev", error: "timeout", visitors: 0, pageviews: 0, series: [], mix: undefined }),
  ];

  it("puts the best score first, and a site that did not answer last", () => {
    const sorted = sortSites(snapshot(rows()).sites, "score");
    expect(sorted[sorted.length - 1]?.site).toBe("dead.dev");
    expect(sorted[0]?.score?.score).not.toBeNull();
  });

  it("ranks the busiest site first by visitors and not necessarily by score", () => {
    const sites = snapshot(rows()).sites;
    expect(sortSites(sites, "visitors")[0]?.site).toBe("busy.dev");
    expect(sortSites(sites, "pageviews")[0]?.site).toBe("nichedb.dev");
  });
});

describe("opening a domain", () => {
  const noop = { refresh: () => {} };

  it("Enter on the list opens the selected property", () => {
    const state = stateWith();
    expect(handleKey(state, { name: "enter" }, noop)).toBe(true);
    expect(state.domain).toBe("nichedb.dev");
  });

  it("Esc, ← and 2 all come back to the list", () => {
    for (const key of ["escape", "backspace", "left", "2"]) {
      const state = stateWith({ domain: "nichedb.dev" });
      expect(handleKey(state, { name: key }, noop)).toBe(true);
      expect(state.domain, key).toBeNull();
    }
  });

  it("Esc on the list itself is not swallowed", () => {
    expect(handleKey(stateWith(), { name: "escape" }, noop)).toBe(false);
  });

  it("↑/↓ move the selection rather than only the scroll", () => {
    const rows = [siteRow(), siteRow({ site: "second.dev", id: "p-2", url: "https://second.dev" })];
    const state = stateWith({ sort: "visitors" }, rows);
    draw(state); // the pane learns how many rows there are by being drawn
    handleKey(state, { name: "down" }, noop);
    expect(state.panes.sites?.selected).toBe(1);
    handleKey(state, { name: "enter" }, noop);
    expect(state.domain).toBe(sortSites(state.snapshot?.sites ?? [], "visitors")[1]?.site);
  });

  it("keeps the highlight on the same property when the order changes", () => {
    const rows = [
      siteRow({ site: "busy.dev", id: "p-2", url: "https://busy.dev", visitors: 90_000, pageviews: 5 }),
      siteRow(),
    ];
    const state = stateWith({ sort: "visitors" }, rows);
    draw(state);
    handleKey(state, { name: "down" }, noop);
    const held = sortSites(state.snapshot?.sites ?? [], "visitors")[1]?.site;
    handleKey(state, { name: "s" }, noop);
    const nowAt = sortSites(state.snapshot?.sites ?? [], state.sort)[state.panes.sites?.selected ?? 0]?.site;
    expect(nowAt).toBe(held);
  });
});

describe("the domain screen", () => {
  const text = (over: Partial<SiteStats> = {}) =>
    draw(stateWith({ domain: "nichedb.dev" }, [siteRow(over)])).text();

  it("leads with the domain and its own traffic", () => {
    const out = text();
    expect(out).toContain("nichedb.dev");
    expect(out).toContain("Pageviews");
    expect(out).toContain("Human share");
    expect(out).toContain("AI referrals");
  });

  it("shows the money for that domain, cost by both denominators", () => {
    const out = text();
    expect(out).toContain("Cost · by views");
    expect(out).toContain("Cost · by visits");
    expect(out).toContain("Ad earned");
  });

  it("shows the score and every component behind it", () => {
    const out = text();
    expect(out).toContain("Risk-to-viral");
    expect(out).toContain("viral");
    expect(out).toContain("risk");
    for (const part of ["Momentum", "Discovery", "Humanity", "Money", "Volatility", "Bot dependence"]) {
      expect(out, part).toContain(part);
    }
    // The formula itself, so nobody has to trust the number.
    expect(out).toMatch(/100 × viral/);
  });

  it("prints a dash and a reason rather than a zero it cannot stand behind", () => {
    const out = text();
    expect(out).toMatch(/Revenue\s+—/);
    expect(out).toMatch(/Earn-rail/);
  });

  it("says so when the site is one that did not answer", () => {
    const out = text({ error: "504 Gateway Timeout", series: [], mix: undefined, visitors: 0, pageviews: 0 });
    expect(out).toContain("504 Gateway Timeout");
    expect(out).toContain("missing, not zero");
  });

  it("says so when the domain is no longer in the snapshot", () => {
    const state = stateWith({ domain: "vanished.dev" });
    expect(draw(state).text()).toContain("not in the current snapshot");
  });

  // hqtui draws a panel's title and its subtitle in the same border row and the
  // subtitle wins, so a subtitle sized against the whole pane costs the panel
  // its own name at exactly the widths nobody renders in a test fixture.
  it("keeps every panel's name at a narrow terminal", () => {
    const state = stateWith({ domain: "nichedb.dev" });
    const narrow = renderToScreen(({ ui, theme }) => renderBody(ui, state, theme), { width: 96, height: 30 });
    for (const title of ["nichedb.dev", "Money", "Risk-to-viral", "Why it scores that"]) {
      expect(narrow.text(), title).toContain(title);
    }
  });
});
