// `crawlproof dashboard` — what the fleet costs and what it returns, live.
//
// Five screens over three feeds: CrawlProof's tracker for who arrived, its ad
// network for what was delivered, and CoinPay for what the bank actually did.
// The interesting screen is the first one, because it is the only place those
// three meet and the only place the answer is a ratio rather than a total.
//
// Built on @profullstack/hqtui, the same library behind `coinpay finances`.

import type { Container, RenderArgs, Theme } from "@profullstack/hqtui";

import { collectDashboard, type CoinPayAuth, type DashboardSnapshot, type SiteStats } from "../lib/dashboard/collect";
import { AD_TARGET_CTR, AD_TARGET_IMPRESSIONS, adTargets } from "../lib/dashboard/roi";
import { buildSiteDetail, type SiteDetail } from "../lib/dashboard/site";
import type { Component } from "../lib/dashboard/score";

export const TABS = ["ROI", "Traffic", "Ads", "Money", "Spend"] as const;
export const RANGES = ["1h", "4h", "1d", "1w", "1m"] as const;

/** How the Traffic list is ordered. `s` cycles it. */
export const SORTS = ["score", "visitors", "pageviews"] as const;
export type Sort = (typeof SORTS)[number];

/** Which tracker range pairs with which CoinPay window. */
export const FINANCE_DAYS: Record<string, number> = {
  "1h": 7,
  "4h": 7,
  "1d": 7,
  "1w": 7,
  "1m": 30,
};

// ── formatting ──

const num = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

export function money(value: unknown, { compact = false, cents = false } = {}): string {
  const v = num(value);
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (compact && abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (compact && abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}k`;
  const digits = cents || abs < 10 ? 2 : abs < 1_000 ? 2 : 0;
  return `${sign}$${abs.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

export function count(value: unknown): string {
  return num(value).toLocaleString("en-US");
}

export function pct(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

/** A ratio people can act on, rather than a decimal they have to convert. */
export function ratio(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(0)}%`;
}

export function ago(at: Date | string | null): string {
  if (!at) return "never";
  const then = at instanceof Date ? at.getTime() : Date.parse(at);
  if (!Number.isFinite(then)) return "never";
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  return `${Math.round(secs / 3600)}h ago`;
}

const clock = () => new Date().toLocaleTimeString("en-US", { hour12: false });

// ── state ──

type Pane = { selected: number; offset: number; total: number };

export type State = {
  tab: number;
  range: string;
  who: string;
  snapshot: DashboardSnapshot | null;
  loading: boolean;
  lastRefresh: Date | null;
  error: string | null;
  paused: boolean;
  showHelp: boolean;
  panes: Record<string, Pane>;
  targetImpressions: number;
  targetCtr: number;
  /**
   * The property the Traffic screen has drilled into, by name.
   *
   * By name rather than by index, because the list reorders on every refresh
   * and on every sort — an index would silently open a different domain the
   * moment anything moved.
   */
  domain: string | null;
  sort: Sort;
};

function pane(state: State, name: string, total: number): Pane {
  let p = state.panes[name];
  if (!p) {
    p = { selected: 0, offset: 0, total: 0 };
    state.panes[name] = p;
  }
  p.total = total;
  const max = Math.max(0, total - 1);
  p.offset = Math.min(p.offset, max);
  p.selected = Math.min(p.selected, max);
  return p;
}

function scrollPane(p: Pane, delta: number, rows = 1): void {
  const max = Math.max(0, p.total - 1);
  p.offset = Math.max(0, Math.min(p.offset + delta * rows, max));
  p.selected = Math.max(p.offset, Math.min(p.selected, max));
}

const TAB_PANE = ["vendors", "sites", "campaigns", "invoices", "ledger"];

const signed = (theme: Theme, v: number) => (v >= 0 ? theme.success : theme.danger);

// ── screens ──

/**
 * The one screen that answers the question in the command's name.
 *
 * Cost and revenue are both monthly rates, because burn is a rate; the window
 * column beside them is that rate prorated onto whatever traffic window is
 * selected, which is the only way the per-visitor numbers mean anything.
 */
function roiScreen(ui: Container, state: State, theme: Theme): void {
  const s = state.snapshot as DashboardSnapshot;
  const r = s.roi;
  const win = `${state.range}`;

  ui.grid({ columns: ["1fr", "1fr", "1fr"], rows: [12, 11, "1fr"], gap: 1 }, (grid) => {
    grid.panel(
      {
        title: "The number",
        // Three different time bases meet on this panel, so each says which.
        subtitle: `${r.cost.scopeMissing ? "whole bank feed" : "business scope"} · ${r.cost.lookbackDays}d avg`,
        subtitleColor: r.cost.scopeMissing ? theme.warning : theme.muted,
      },
      (p) => {
        p.keyValues(
          [
            { label: "Cost", value: `${money(r.cost.perMonthUsd)}/mo`, color: theme.danger },
            {
              label: `Revenue (${r.revenue.observedDays}d)`,
              value: `${money(r.revenue.perMonthUsd)}/mo`,
              color: theme.success,
            },
            {
              label: "Net",
              value: `${money(r.derived.netPerMonthUsd)}/mo`,
              color: signed(theme, r.derived.netPerMonthUsd),
            },
            {
              label: "ROI",
              value: ratio(r.derived.roi),
              color: (r.derived.roi ?? -1) >= 0 ? theme.success : theme.danger,
            },
            {
              label: "Months of cover",
              value: r.derived.monthsOfCover === null ? "—" : r.derived.monthsOfCover.toFixed(1),
              color: (r.derived.monthsOfCover ?? 0) < 3 ? theme.warning : theme.success,
            },
            { label: "", value: "" },
            { label: `Cost · ${win}`, value: money(r.cost.windowUsd) },
            { label: `Revenue · ${win}`, value: money(r.revenue.windowUsd) },
          ],
          { labelWidth: 17 },
        );
      },
    );

    grid.panel({ title: "Per visitor", subtitle: `${win} · ${state.who}` }, (p) => {
      p.keyValues(
        [
          { label: "Visitors", value: count(r.attention.visitors), color: theme.primary },
          { label: "Pageviews", value: count(r.attention.pageviews) },
          {
            label: "Cost each",
            value: r.derived.costPerVisitorUsd === null ? "—" : money(r.derived.costPerVisitorUsd, { cents: true }),
            color: theme.danger,
          },
          {
            label: "Revenue each",
            value:
              r.derived.revenuePerVisitorUsd === null ? "—" : money(r.derived.revenuePerVisitorUsd, { cents: true }),
            color: theme.success,
          },
          {
            label: "Cost per view",
            value:
              r.derived.costPerPageviewUsd === null ? "—" : money(r.derived.costPerPageviewUsd, { cents: true }),
            color: theme.danger,
          },
          {
            label: "Break-even",
            value:
              r.derived.breakEvenVisitors === null
                ? "—"
                : `${count(Math.ceil(r.derived.breakEvenVisitors))} visitors/mo`,
            color: theme.warning,
          },
          { label: "", value: "" },
          {
            label: "Sites reporting",
            value: `${r.attention.sitesReporting} of ${r.attention.sites}`,
            color: r.attention.sitesReporting < r.attention.sites ? theme.warning : theme.muted,
          },
        ],
        { labelWidth: 16 },
      );
    });

    grid.panel(
      { title: "Internal", subtitle: "one account, both sides · lifetime", subtitleColor: theme.muted },
      (p) => {
        p.text("Ad money moving between our own products.", { fg: theme.muted });
        p.text("Counted as neither cost nor revenue.", { fg: theme.muted });
        p.keyValues(
          [
            { label: "Ad spend", value: money(r.internal.adSpendUsd) },
            { label: "Ad earnings", value: money(r.internal.adEarnedUsd) },
            {
              label: "Net",
              value: money(r.internal.netUsd),
              color: Math.abs(r.internal.netUsd) < 1 ? theme.muted : theme.warning,
            },
            { label: "Available", value: money(r.internal.availableUsd) },
          ],
          { labelWidth: 14 },
        );
      },
    );

    grid.panel(
      {
        title: "Where the money goes",
        // The bank window, which is NOT the traffic range in the header. Bank
        // data has no hourly resolution, so these differ on every range below
        // a month and an unlabelled panel invites the wrong reading.
        subtitle: `last ${s.window.financeDays}d · business accounts`,
        colSpan: 2,
      },
      (p) => {
      const vendors = r.cost.vendors.slice(0, 8);
      if (!vendors.length) {
        p.text("No business debits in the window.", { fg: theme.muted });
        return;
      }
      const max = Math.max(1, ...vendors.map((v) => v.usd));
      p.meters(
        vendors.map((v) => ({
          label: v.payee.slice(0, 18),
          value: v.usd,
          max,
          text: money(v.usd, { compact: true }),
        })),
        { labelWidth: 19, valueWidth: 8 },
      );
      },
    );

    grid.panel({ title: "Reach", subtitle: `ads ${s.ads?.rangeDays ?? "?"}d · money ${r.revenue.observedDays}d` }, (p) => {
      p.keyValues(
        [
          { label: "Impressions", value: count(r.attention.impressions) },
          { label: "Clicks", value: count(r.attention.clicks) },
          { label: "CTR", value: pct(r.attention.ctr, 2) },
          { label: "", value: "" },
          // Both are rates built from the day series. The lifetime totals sit
          // underneath them precisely so the large number is visible without
          // being mistaken for a run rate.
          { label: "Merchant volume", value: `${money(r.revenue.grossVolumePerMonthUsd, { compact: true })}/mo` },
          { label: "Our commission", value: `${money(r.revenue.commissionPerMonthUsd)}/mo`, color: theme.success },
          {
            label: "  lifetime volume",
            value: money(r.revenue.lifetimeGrossVolumeUsd, { compact: true }),
            color: theme.muted,
          },
          {
            label: "  lifetime commission",
            value: money(r.revenue.lifetimeCommissionUsd),
            color: theme.muted,
          },
        ],
        { labelWidth: 21 },
      );
    });

    grid.panel({ title: "Read this before quoting a number", colSpan: 3 }, (p) => {
      if (!r.caveats.length) {
        p.text("Every source answered and every figure is scoped as labelled.", { fg: theme.success });
        return;
      }
      for (const c of r.caveats) p.text(`· ${c}`, { fg: theme.warning });
    });
  });
}

/**
 * The properties, in whatever order was asked for.
 *
 * Sites that did not answer sort last whatever the key, because a site with no
 * numbers is not a site with low numbers; and a null score sorts below a real
 * one rather than above it, which is what `?? 0` would have done.
 */
export function sortSites(sites: SiteStats[], sort: Sort): SiteStats[] {
  const key = (row: SiteStats): number => {
    if (sort === "visitors") return num(row.visitors);
    if (sort === "pageviews") return num(row.pageviews);
    return row.score?.score ?? -1;
  };
  return [...sites].sort((a, b) => {
    if (Boolean(a.error) !== Boolean(b.error)) return a.error ? 1 : -1;
    return key(b) - key(a) || a.site.localeCompare(b.site);
  });
}

type ThemeColor = Theme["success"];

/** Score bands, so a glance at the column means something without reading it. */
export function scoreColor(theme: Theme, score: number | null | undefined): ThemeColor | undefined {
  if (score === null || score === undefined) return theme.muted;
  if (score >= 60) return theme.success;
  if (score >= 35) return theme.primary;
  if (score >= 15) return theme.warning;
  return theme.muted;
}

export function scoreText(row: SiteStats): string {
  const value = row.score?.score;
  if (value === null || value === undefined) return "—";
  // A trailing ~ marks a score from too small a sample to lean on. The number
  // is still shown: hiding it would only move the guess into someone's head.
  return `${value.toFixed(0)}${row.score?.provisional ? "~" : ""}`;
}

function trafficScreen(ui: Container, state: State, theme: Theme): void {
  const s = state.snapshot as DashboardSnapshot;
  const rows = sortSites(s.sites, state.sort);

  ui.grid({ columns: ["3fr", "2fr"], gap: 1 }, (grid) => {
    grid.panel(
      {
        title: `Sites · ${state.range} · ${state.who}`,
        subtitle: `${s.roi.attention.sitesReporting} of ${rows.length} reporting · by ${state.sort}`,
        footer: "↑/↓ select · Enter opens · s sorts",
      },
      (p) => {
        const view = pane(state, "sites", rows.length);
        /** Absolute row indexes the table drew this frame, in screen order. */
        const drawn: number[] = [];
        type SiteRow = {
          site: string;
          score: string;
          scoreValue: number | null;
          visitors: string;
          pageviews: string;
          cost: string;
          note: string;
        };
        p.table<SiteRow>({
          columns: [
            {
              key: "site",
              title: "Site",
              width: 26,
              // A site that did not answer is coloured, not silently ordinary.
              color: (row: SiteRow) => (row.note ? theme.danger : undefined),
            },
            {
              key: "score",
              title: "Score",
              align: "right",
              width: 6,
              color: (row: SiteRow) => scoreColor(theme, row.scoreValue),
            },
            { key: "visitors", title: "Visitors", align: "right", width: 10 },
            { key: "pageviews", title: "Views", align: "right", width: 9 },
            { key: "cost", title: "Cost", align: "right", width: 10 },
            { key: "note", title: "", width: 14, color: theme.danger },
          ],
          rows: rows.map((row) => {
            const share = s.roi.attention.visitors > 0 ? row.visitors / s.roi.attention.visitors : 0;
            return {
              site: row.site,
              score: row.error ? "—" : scoreText(row),
              scoreValue: row.error ? null : (row.score?.score ?? null),
              visitors: row.error ? "—" : count(row.visitors),
              pageviews: row.error ? "—" : count(row.pageviews),
              cost: row.error ? "—" : money(s.roi.cost.windowUsd * share, { cents: true }),
              note: row.error ? row.error.slice(0, 14) : "",
            };
          }),
          offset: view.offset,
          selected: view.selected,
          // The table scrolls itself to keep the selection visible, which means
          // it — not this — knows where the window actually starts. `onRow`
          // reports that back, both so the stored offset stays truthful and so
          // a click can be mapped to a row rather than to an assumption.
          followSelection: true,
          scrollbar: true,
          onRow: (_row: SiteRow, index: number) => {
            if (!drawn.length) view.offset = index;
            drawn.push(index);
          },
          onScroll: (delta: number) => scrollPane(view, delta, 3),
          // A click is a selection and an open, the way a click on a row in any
          // other list is. Row 0 is the first body row; the header only focuses.
          onSelectRow: (visibleRow: number) => {
            const index = drawn[visibleRow];
            const row = index === undefined ? undefined : rows[index];
            if (!row || index === undefined) return;
            view.selected = index;
            state.domain = row.site;
          },
        });
      },
    );

    grid.cell({ gap: 1 }, (col) => {
      col.panel({ title: "Where they came from" }, (p) => {
        if (!s.fleet.sources.length) {
          p.text("Nobody arrived in this window.", { fg: theme.muted });
          return;
        }
        const max = Math.max(1, ...s.fleet.sources.map((x) => x.value));
        p.meters(
          s.fleet.sources.slice(0, 8).map((x) => ({
            label: x.label.slice(0, 22),
            value: x.value,
            max,
            text: count(x.value),
          })),
          { labelWidth: 23, valueWidth: 7 },
        );
      });

      col.panel({ title: "Most-read pages" }, (p) => {
        if (!s.fleet.pages.length) {
          p.text("No pages read in this window.", { fg: theme.muted });
          return;
        }
        p.keyValues(
          s.fleet.pages.slice(0, 10).map((x) => ({
            label: x.label.slice(0, 30),
            value: count(x.value),
          })),
          { labelWidth: 31 },
        );
      });
    });
  });
}

/** The site the Traffic screen has opened, if it is still in the snapshot. */
export function selectedSite(state: State): SiteStats | null {
  if (!state.domain || !state.snapshot) return null;
  return state.snapshot.sites.find((s) => s.site === state.domain) ?? null;
}

/** Rebuild one property's whole picture from the snapshot already in hand. */
export function detailFor(state: State): SiteDetail | null {
  const site = selectedSite(state);
  const s = state.snapshot;
  if (!site || !s) return null;
  return buildSiteDetail({
    site,
    roi: s.roi,
    ads: s.ads,
    finance: s.finance,
    window: { range: s.window.range, who: s.window.who, financeDays: s.window.financeDays },
  });
}

type ComponentRow = { part: string; value: string; why: string; color: ThemeColor | undefined };

const componentRows = (components: Component[], theme: Theme): ComponentRow[] =>
  components.map((c) => ({
    part: `${c.label} ·${(c.weight * 100).toFixed(0)}`,
    value: c.value === null ? "—" : pct(c.value, 0),
    why: c.detail,
    color: c.value === null ? theme.muted : undefined,
  }));

/**
 * One property, on its own: what arrived, what it cost and earned, and why it
 * scores what it scores.
 *
 * Every figure comes from the snapshot the list was drawn from, so opening a
 * domain cannot show a number the row behind it disagreed with, and Esc goes
 * back to exactly the list that was there.
 */
function domainScreen(ui: Container, state: State, theme: Theme): void {
  const detail = detailFor(state);
  if (!detail) {
    ui.panel({ title: state.domain ?? "Site" }, (p) => {
      p.text("That site is not in the current snapshot.", { fg: theme.warning });
      p.text("Esc goes back to the list.", { fg: theme.muted });
    });
    return;
  }

  const t = detail.traffic;
  const m = detail.money;
  const score = detail.score;

  ui.grid({ columns: ["1fr", "1fr", "1fr"], rows: [12, "1fr"], gap: 1 }, (grid) => {
    grid.panel(
      {
        title: detail.site,
        subtitle: `${detail.window.range} · ${detail.window.who}`,
        titleColor: theme.title,
      },
      (p) => {
        if (detail.error) {
          p.text(detail.error, { fg: theme.danger });
          p.text("Its numbers are missing, not zero.", { fg: theme.muted });
          return;
        }
        p.keyValues(
          [
            { label: "Pageviews", value: count(t.pageviews), color: theme.primary },
            { label: "Visits", value: count(t.visitors) },
            { label: "Humans", value: t.mixKnown ? count(t.humans) : "—", color: theme.success },
            { label: "Bots", value: t.mixKnown ? count(t.bots) : "—", color: theme.warning },
            {
              label: "Human share",
              value: pct(t.humanShare, 0),
              color: (t.humanShare ?? 1) < 0.5 ? theme.warning : theme.success,
            },
            { label: "AI referrals", value: count(t.aiReferrals) },
            { label: "", value: "" },
            { label: "Share of views", value: pct(t.viewShare, 1) },
            { label: "Share of visits", value: pct(t.visitShare, 1) },
          ],
          { labelWidth: 15 },
        );
        const line = t.series.map((point) => num(point.humans));
        if (line.length > 1) {
          p.sparkline({ values: line, color: theme.success, label: "humans", text: count(t.humans) });
        }
      },
    );

    // Short subtitles on purpose: hqtui draws the title and the subtitle in the
    // same border row and the subtitle wins, so a long one costs the panel its
    // own name at a narrow width.
    grid.panel({ title: "Money", subtitle: `${detail.window.range} · ${detail.window.financeDays}d bank` }, (p) => {
      p.keyValues(
        [
          {
            label: "Cost · by views",
            value: m.costByViewsUsd === null ? "—" : money(m.costByViewsUsd, { cents: true }),
            color: theme.danger,
          },
          {
            label: "Cost · by visits",
            value: m.costByVisitsUsd === null ? "—" : money(m.costByVisitsUsd, { cents: true }),
            color: theme.muted,
          },
          {
            label: "Revenue",
            value: m.revenueUsd === null ? "—" : money(m.revenueUsd, { cents: true }),
            color: theme.success,
          },
          {
            label: "Net",
            value: m.netUsd === null ? "—" : money(m.netUsd, { cents: true }),
            color: m.netUsd === null ? theme.muted : signed(theme, m.netUsd),
          },
          {
            label: "Per 1k humans",
            value: m.rpmUsd === null ? "—" : money(m.rpmUsd, { cents: true }),
          },
          { label: "", value: "" },
          // Internal by construction: one account owns the slot and the
          // campaign, so this is the same dollar in two pockets.
          { label: "Ad earned (int.)", value: money(m.adEarnedUsd, { cents: true }), color: theme.muted },
          { label: "Ad spent (int.)", value: money(m.adSpentUsd, { cents: true }), color: theme.muted },
          { label: "Impressions", value: count(m.adImpressions), color: theme.muted },
        ],
        { labelWidth: 17 },
      );
    });

    grid.panel(
      {
        title: "Risk-to-viral",
        subtitle: score.provisional ? "provisional" : `${pct(score.coverage, 0)} scored`,
        subtitleColor: score.provisional ? theme.warning : theme.muted,
      },
      (p) => {
        p.text(score.score === null ? "  —" : `  ${score.score.toFixed(0)}`, {
          bold: true,
          fg: scoreColor(theme, score.score),
        });
        p.meters(
          [
            { label: "viral", value: score.viral, max: 1, text: pct(score.viral, 0) },
            { label: "risk", value: score.risk, max: 1, text: pct(score.risk, 0) },
          ],
          { labelWidth: 7, valueWidth: 6 },
        );
        p.text("100 × viral × (1 − risk/2)", { fg: theme.muted });
        for (const note of score.notes.slice(0, 2)) p.text(`· ${note}`, { fg: theme.warning, wrap: true });
      },
    );

    grid.panel({ title: "Why it scores that", subtitle: "weights", colSpan: 2 }, (p) => {
      p.table<ComponentRow>({
        columns: [
          { key: "part", title: "Viral", width: 23 },
          { key: "value", title: "", align: "right", width: 6 },
          { key: "why", title: "", width: 41, color: theme.muted },
        ],
        rows: componentRows(score.viralComponents, theme),
        rowColor: (row: ComponentRow) => row.color,
      });
      p.table<ComponentRow>({
        columns: [
          { key: "part", title: "Risk", width: 23 },
          { key: "value", title: "", align: "right", width: 6 },
          { key: "why", title: "", width: 41, color: theme.muted },
        ],
        rows: componentRows(score.riskComponents, theme),
        rowColor: (row: ComponentRow) => row.color,
      });
      for (const gap of detail.gaps.slice(0, 3)) p.text(`· ${gap}`, { fg: theme.muted, wrap: true });
    });

    grid.cell({ gap: 1 }, (col) => {
      col.panel({ title: "Where they came from" }, (p) => {
        if (!t.sources.length) {
          p.text("Nobody arrived in this window.", { fg: theme.muted });
          return;
        }
        const max = Math.max(1, ...t.sources.map((x) => num(x.value)));
        p.meters(
          t.sources.slice(0, 6).map((x) => ({
            label: x.label.slice(0, 20),
            value: num(x.value),
            max,
            text: count(x.value),
          })),
          { labelWidth: 21, valueWidth: 7 },
        );
      });

      col.panel({ title: "Most-read pages" }, (p) => {
        if (!t.pages.length) {
          p.text("No pages read in this window.", { fg: theme.muted });
          return;
        }
        p.keyValues(
          t.pages.slice(0, 6).map((x) => ({ label: x.label.slice(0, 26), value: count(x.value) })),
          { labelWidth: 27 },
        );
      });
    });
  });
}

function adsScreen(ui: Container, state: State, theme: Theme): void {
  const s = state.snapshot as DashboardSnapshot;
  const ads = s.ads;

  if (!ads) {
    ui.panel({ title: "Ads" }, (p) => {
      p.text(s.errors.ads ?? "Ad earnings unavailable.", { fg: theme.danger });
      p.text("Press r to retry.", { fg: theme.muted });
    });
    return;
  }

  const t = adTargets(ads, { targetImpressions: state.targetImpressions, targetCtr: state.targetCtr });
  const spent = num(ads.totals?.spentCents) / 100;
  const earned = num(ads.totals?.earnedCents) / 100;
  const window =
    (ads as { deliveryWindow?: string }).deliveryWindow === "lifetime" ? "lifetime" : `${ads.rangeDays ?? "?"}d`;

  ui.grid({ columns: ["1fr", "1fr", "1fr"], rows: [13, "1fr"], gap: 1 }, (grid) => {
    // Free first, because the network is free backfill today and leading with
    // the paid columns reports a working network as a dead one.
    grid.panel({ title: "Delivered", subtitle: window }, (p) => {
      p.keyValues(
        [
          { label: "Impressions", value: count(t.impressions), color: theme.primary },
          { label: "  free", value: count(t.freeImpressions), color: theme.success },
          { label: "  paid", value: count(t.paidImpressions), color: theme.muted },
          { label: "Clicks", value: count(t.clicks) },
          { label: "CTR", value: pct(t.ctr, 3) },
          {
            label: "Invalid clicks",
            value: count(t.invalidClicks),
            color: t.invalidClicks > t.clicks ? theme.danger : theme.warning,
          },
        ],
        { labelWidth: 16 },
      );
      if (t.invalidClicks > t.clicks && t.clicks > 0) {
        p.text(`${Math.round(t.invalidClicks / t.clicks)}x more invalid than valid.`, { fg: theme.danger });
      }
    });

    grid.panel(
      { title: "Toward the target", subtitle: `${count(t.targetImpressions)}/mo · ${pct(t.targetCtr, 0)} CTR` },
      (p) => {
        p.meters(
          [
            {
              label: "impressions",
              value: Math.min(1, t.impressionProgress),
              max: 1,
              text: pct(t.impressionProgress, 1),
            },
            { label: "CTR", value: Math.min(1, t.ctrProgress), max: 1, text: pct(t.ctrProgress, 1) },
          ],
          { labelWidth: 12, valueWidth: 8 },
        );
        p.keyValues(
          [
            { label: "Short by", value: count(Math.max(0, t.targetImpressions - t.impressions)) },
            {
              label: "Cost per click",
              value: t.cpcCents === null ? "nothing charged yet" : `${t.cpcCents.toFixed(1)}c`,
            },
            {
              label: "At target",
              value: t.projectedMonthlyUsd === null ? "-" : `${money(t.projectedMonthlyUsd)}/mo`,
              color: theme.success,
            },
          ],
          { labelWidth: 16 },
        );
      },
    );

    grid.panel({ title: "Net of the network", subtitle: "one account, both sides" }, (p) => {
      p.text("We advertise on our own slots, so these", { fg: theme.muted });
      p.text("two sides are the same dollar.", { fg: theme.muted });
      p.keyValues(
        [
          { label: "Spend", value: `-${money(spent)}` },
          { label: "Earned", value: `+${money(earned)}` },
          {
            label: "Net",
            value: money(earned - spent),
            color: Math.abs(earned - spent) < 1 ? theme.muted : theme.warning,
          },
          { label: "Available", value: money(num(ads.totals?.availableCents) / 100) },
        ],
        { labelWidth: 12 },
      );
      if (ads.statsUnavailable) {
        p.text("A delivery query failed; counts are low.", { fg: theme.danger });
      }
    });

    grid.panel({ title: "Ad-driven arrivals", colSpan: 3, subtitle: "sources bucketed as Ad" }, (p) => {
      const adSources = s.fleet.sources.filter((x) => x.label.startsWith("Ad "));
      if (!adSources.length) {
        p.text("No arrivals attributed to an ad in this window.", { fg: theme.muted });
        return;
      }
      const max = Math.max(1, ...adSources.map((x) => x.value));
      p.meters(
        adSources.slice(0, 10).map((x) => ({
          label: x.label.replace(/^Ad . /, "").slice(0, 24),
          value: x.value,
          max,
          text: count(x.value),
        })),
        { labelWidth: 25, valueWidth: 7 },
      );
    });
  });
}

function moneyScreen(ui: Container, state: State, theme: Theme): void {
  const s = state.snapshot as DashboardSnapshot;
  const f = s.finance;

  if (!f) {
    ui.panel({ title: "Money" }, (p) => {
      p.text(s.errors.finance ?? "CoinPay unavailable.", { fg: theme.danger });
      p.text("`coinpay auth login` writes the session this reads.", { fg: theme.muted });
    });
    return;
  }

  const e = f.earnings ?? {};
  const bank = (f as { bank?: Record<string, unknown> }).bank ?? {};
  const cash = (bank.cashflow ?? {}) as Record<string, number>;
  const invoices = (f as { invoices?: { totals?: Record<string, number>; counts?: Record<string, number> } })
    .invoices ?? {};

  ui.grid({ columns: ["1fr", "1fr", "1fr"], rows: [12, "1fr"], gap: 1 }, (grid) => {
    grid.panel({ title: `Earnings · ${s.window.financeDays}d` }, (p) => {
      p.keyValues(
        [
          { label: "Gross volume", value: money(e.grossVolumeUsd), color: theme.primary },
          { label: "Commission", value: money(e.commissionUsd), color: theme.success },
          { label: "Net", value: money(e.netUsd) },
        ],
        { labelWidth: 16 },
      );
    });

    grid.panel({ title: "Bank & cards" }, (p) => {
      p.keyValues(
        [
          { label: "Assets", value: money(bank.assets), color: theme.success },
          { label: "Owed", value: money(bank.liabilities), color: theme.danger },
          { label: "Net", value: money(bank.net), color: signed(theme, num(bank.net)) },
          { label: `In · ${s.window.financeDays}d`, value: money(cash.moneyIn), color: theme.success },
          { label: `Out · ${s.window.financeDays}d`, value: money(cash.moneyOut), color: theme.danger },
          { label: "Accounts", value: count(bank.accountCount) },
        ],
        { labelWidth: 16 },
      );
    });

    grid.panel({ title: "Owed to us" }, (p) => {
      p.keyValues(
        [
          {
            label: "Outstanding",
            value: `${money(invoices.totals?.outstanding)}  (${count(invoices.counts?.outstanding)})`,
            color: theme.warning,
          },
          {
            label: "Overdue",
            value: `${money(invoices.totals?.overdue)}  (${count(invoices.counts?.overdue)})`,
            color: num(invoices.counts?.overdue) > 0 ? theme.danger : theme.muted,
          },
          {
            label: "Paid",
            value: `${money(invoices.totals?.paid)}  (${count(invoices.counts?.paid)})`,
            color: theme.success,
          },
          { label: "Draft", value: `${money(invoices.totals?.draft)}  (${count(invoices.counts?.draft)})` },
        ],
        { labelWidth: 14 },
      );
    });

    grid.panel({ title: "Income vs spending", colSpan: 3, subtitle: "by month, from the bank feed" }, (p) => {
      const months = (f.position as { months?: Array<Record<string, number | string>> })?.months ?? [];
      if (!months.length) {
        p.text("Not enough bank history to plot a month.", { fg: theme.muted });
        return;
      }
      p.multiGraph(
        [
          { values: months.map((m) => num(m.income)), color: theme.success, label: "income", fill: true },
          { values: months.map((m) => num(m.spending)), color: theme.danger, label: "spending" },
        ],
        {
          min: 0,
          axis: true,
          axisFormat: (v: number) => money(v, { compact: true }),
          timeAxis: months.map((m) => String(m.month ?? "")),
          legend: true,
        },
      );
    });
  });
}

function spendScreen(ui: Container, state: State, theme: Theme): void {
  const s = state.snapshot as DashboardSnapshot;
  const r = s.roi;

  if (!s.finance) {
    ui.panel({ title: "Spend" }, (p) => {
      p.text(s.errors.finance ?? "CoinPay unavailable.", { fg: theme.danger });
    });
    return;
  }

  const bank = (s.finance as { bank?: Record<string, unknown> }).bank ?? {};
  const categories = (bank.topCategories ?? []) as Array<{ category: string | null; spent: number; count: number }>;

  ui.grid({ columns: ["3fr", "2fr"], gap: 1 }, (grid) => {
    grid.panel(
      {
        title: "Who we pay",
        subtitle: r.cost.vendorsPartial
          ? `last ${s.window.financeDays}d · newest page of the ledger`
          : `last ${s.window.financeDays}d`,
        subtitleColor: r.cost.vendorsPartial ? theme.warning : theme.muted,
        footer: "business accounts only",
      },
      (p) => {
        const rows = r.cost.vendors;
        if (!rows.length) {
          p.text("No business debits in the window.", { fg: theme.muted });
          return;
        }
        const view = pane(state, "ledger", rows.length);
        p.table({
          columns: [
            { key: "payee", title: "Payee", width: 30 },
            { key: "usd", title: "Spent", align: "right", width: 12 },
            { key: "charges", title: "Charges", align: "right", width: 9 },
            { key: "share", title: "Share", align: "right", width: 8 },
          ],
          rows: rows.map((v) => ({
            payee: v.payee,
            usd: money(v.usd),
            charges: count(v.charges),
            share: pct(r.cost.perMonthUsd > 0 ? v.usd / r.cost.perMonthUsd : null, 0),
          })),
          offset: view.offset,
          selected: view.selected,
          scrollbar: true,
          onScroll: (delta: number) => scrollPane(view, delta, 3),
        });
      },
    );

    grid.cell({ gap: 1 }, (col) => {
      col.panel({ title: "Burn" }, (p) => {
        p.keyValues(
          [
            { label: "Business", value: `${money(r.cost.perMonthUsd)}/mo`, color: theme.danger },
            { label: "All accounts", value: `${money(r.cost.allScopesPerMonthUsd)}/mo`, color: theme.muted },
            { label: "", value: "" },
            { label: "Revenue", value: `${money(r.revenue.perMonthUsd)}/mo`, color: theme.success },
            {
              label: "Net",
              value: `${money(r.derived.netPerMonthUsd)}/mo`,
              color: signed(theme, r.derived.netPerMonthUsd),
            },
          ],
          { labelWidth: 15 },
        );
      });

      col.panel({ title: "By category", subtitle: "all accounts" }, (p) => {
        if (!categories.length) {
          p.text("Nothing categorised yet.", { fg: theme.muted });
          return;
        }
        const max = Math.max(1, ...categories.map((c) => num(c.spent)));
        p.meters(
          categories.slice(0, 9).map((c) => ({
            label: (c.category ?? "uncategorised").slice(0, 16),
            value: num(c.spent),
            max,
            text: money(c.spent, { compact: true }),
          })),
          { labelWidth: 17, valueWidth: 8 },
        );
      });
    });
  });
}

const SCREENS = [roiScreen, trafficScreen, adsScreen, moneyScreen, spendScreen];

/**
 * Draw whichever screen the state is on.
 *
 * One function rather than an index into SCREENS at the call site, because the
 * Traffic tab has two screens — the list and one property — and the choice
 * between them is state, not a tab. Exported so the render tests draw exactly
 * what the app draws.
 */
export function renderBody(ui: Container, state: State, theme: Theme): void {
  if (!state.snapshot) {
    ui.panel({ title: "Spend & ROI" }, (p) => {
      if (state.error) {
        p.text(`Could not load: ${state.error}`, { fg: theme.danger });
        p.text("Press r to retry, q to quit.", { fg: theme.muted });
      } else {
        p.text("Reading the fleet…", { fg: theme.muted });
        p.text("One tracker call per site, plus ad earnings and CoinPay.", { fg: theme.muted });
      }
    });
    return;
  }
  if (state.tab === 1 && state.domain) {
    domainScreen(ui, state, theme);
    return;
  }
  (SCREENS[state.tab] ?? roiScreen)(ui, state, theme);
}

/** A fresh state, for `runDashboard` and for the render tests alike. */
export function initialState(overrides: Partial<State> = {}): State {
  return {
    tab: 0,
    range: "1d",
    who: "humans",
    snapshot: null,
    loading: false,
    lastRefresh: null,
    error: null,
    paused: false,
    showHelp: false,
    panes: {},
    targetImpressions: AD_TARGET_IMPRESSIONS,
    targetCtr: AD_TARGET_CTR,
    domain: null,
    sort: "score",
    ...overrides,
  };
}

/** Move the highlighted row, letting the table work out the scroll. */
function moveSelection(p: Pane, delta: number): void {
  const max = Math.max(0, p.total - 1);
  p.selected = Math.max(0, Math.min(p.selected + delta, max));
}

export type KeyLike = { name: string; shift?: boolean };

/**
 * Every key the dashboard answers to, as a pure function of the state.
 *
 * Pulled out of the app so the navigation that matters — opening a domain,
 * coming back from it, re-sorting without losing your place — can be tested
 * without a terminal. Returns true when something changed and the frame is
 * worth redrawing.
 */
export function handleKey(state: State, event: KeyLike, actions: { refresh: () => void }): boolean {
  if (state.showHelp) {
    state.showHelp = false;
    return true;
  }

  const onTraffic = state.tab === 1;
  const sites = state.snapshot ? sortSites(state.snapshot.sites, state.sort) : [];
  const view = pane(state, TAB_PANE[state.tab] as string, state.panes[TAB_PANE[state.tab] as string]?.total ?? 0);

  // A number is always the top-level screen it names, so 2 is the way back to
  // the list from a domain as well as the way to the Traffic tab from anywhere.
  const digit = Number(event.name);
  if (Number.isInteger(digit) && event.name.length === 1 && digit >= 1 && digit <= TABS.length) {
    state.tab = digit - 1;
    state.domain = null;
    return true;
  }

  switch (event.name) {
    case "escape":
    case "backspace":
      if (!state.domain) return false;
      state.domain = null;
      return true;

    case "enter":
    case "return":
    case "right": {
      // → opens a domain from the list, and otherwise keeps its old job of
      // moving to the next screen.
      if (onTraffic && !state.domain && sites.length) {
        const row = sites[Math.min(view.selected, sites.length - 1)];
        if (row) {
          state.domain = row.site;
          return true;
        }
      }
      if (event.name !== "right") return false;
      state.tab = event.shift ? (state.tab + TABS.length - 1) % TABS.length : (state.tab + 1) % TABS.length;
      return true;
    }

    case "tab":
    case "l":
      state.tab = event.shift ? (state.tab + TABS.length - 1) % TABS.length : (state.tab + 1) % TABS.length;
      return true;

    case "left":
    case "h":
      // ← is the way back out of a domain too, since that is where it came from.
      if (state.domain) {
        state.domain = null;
        return true;
      }
      state.tab = (state.tab + TABS.length - 1) % TABS.length;
      return true;

    case "s": {
      // Re-sorting keeps the highlight on the same property rather than on the
      // same row number, which is the only version of this that is not annoying.
      const held = sites[view.selected]?.site ?? null;
      state.sort = SORTS[(SORTS.indexOf(state.sort) + 1) % SORTS.length] as Sort;
      if (held && state.snapshot) {
        const next = sortSites(state.snapshot.sites, state.sort).findIndex((row) => row.site === held);
        if (next >= 0) view.selected = next;
      }
      return true;
    }

    case "r":
    case "f5":
      actions.refresh();
      return true;

    case "w":
      state.range = RANGES[(RANGES.indexOf(state.range as never) + 1) % RANGES.length] as string;
      actions.refresh();
      return true;

    case "b":
      state.who = state.who === "humans" ? "all" : state.who === "all" ? "bots" : "humans";
      actions.refresh();
      return true;

    case "p":
    case "space":
      state.paused = !state.paused;
      return true;

    case "?":
    case "f1":
      state.showHelp = true;
      return true;

    case "up":
    case "k":
      if (onTraffic && !state.domain) moveSelection(view, -1);
      else scrollPane(view, -1);
      return true;

    case "down":
    case "j":
      if (onTraffic && !state.domain) moveSelection(view, 1);
      else scrollPane(view, 1);
      return true;

    case "pageup":
      if (onTraffic && !state.domain) moveSelection(view, -10);
      else scrollPane(view, -1, 10);
      return true;

    case "pagedown":
      if (onTraffic && !state.domain) moveSelection(view, 10);
      else scrollPane(view, 1, 10);
      return true;

    default:
      return false;
  }
}

// ── app ──

async function loadHqtui(): Promise<typeof import("@profullstack/hqtui")> {
  try {
    return await import("@profullstack/hqtui");
  } catch (err) {
    const [major, minor] = process.versions.node.split(".").map(Number);
    const tooOld = (major ?? 0) < 22 || ((major ?? 0) === 22 && (minor ?? 0) < 6);
    const message = tooOld
      ? `The dashboard needs Node 22.6 or newer (you have ${process.versions.node}).`
      : `Could not load @profullstack/hqtui: ${(err as Error)?.message ?? err}`;
    throw new Error(`${message} Use \`crawlproof stats\` for a plain-text answer.`);
  }
}

export type DashboardOptions = {
  baseUrl: string;
  token: string;
  range?: string;
  who?: string;
  interval?: number;
  concurrency?: number;
  coinpay: CoinPayAuth | null;
  only?: string[] | null;
  theme?: string;
  /** Where the ad network is trying to get to; see lib/dashboard/roi.ts. */
  targetImpressions?: number;
  targetCtr?: number;
  /** Initial order of the Traffic list: score, visitors or pageviews. */
  sort?: string;
};

export async function runDashboard(opts: DashboardOptions): Promise<void> {
  const hqtui = await loadHqtui();
  const app = await hqtui.createApp({
    fps: 30,
    theme: (opts.theme as never) || "dark",
    quitKeys: ["ctrl+c", "q"],
  });

  const state: State = initialState({
    range: opts.range && RANGES.includes(opts.range as never) ? opts.range : "1d",
    who: opts.who ?? "humans",
    targetImpressions: opts.targetImpressions ?? AD_TARGET_IMPRESSIONS,
    targetCtr: opts.targetCtr ?? AD_TARGET_CTR,
    ...(opts.sort && SORTS.includes(opts.sort as never) ? { sort: opts.sort as Sort } : {}),
  });

  let refreshing = false;

  async function refresh(): Promise<void> {
    if (refreshing) return;
    refreshing = true;
    state.loading = true;
    app.invalidate();
    try {
      state.snapshot = await collectDashboard({
        baseUrl: opts.baseUrl,
        token: opts.token,
        range: state.range,
        who: state.who,
        financeDays: FINANCE_DAYS[state.range] ?? 30,
        concurrency: opts.concurrency ?? 8,
        coinpay: opts.coinpay,
        only: opts.only ?? null,
      });
      state.error = null;
      state.lastRefresh = new Date();
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err);
    } finally {
      state.loading = false;
      refreshing = false;
      app.invalidate();
    }
  }

  const interval = Math.max(10, opts.interval ?? 60);
  const poll = setInterval(() => {
    if (!state.paused) void refresh();
  }, interval * 1000);
  poll.unref?.();

  const tick = setInterval(() => app.invalidate(), 1000);
  tick.unref?.();

  app.on("key", (event: KeyLike) => {
    if (handleKey(state, event, { refresh })) app.invalidate();
  });

  app.render(({ ui, theme, height }: RenderArgs) => {
    ui.row({ size: 1 }, (header) => {
      header.text(" CrawlProof ", { fg: theme.title, bold: true, size: 12 });
      header.tabs({
        tabs: TABS.map((name, i) => `${i + 1} ${name}`),
        active: state.tab,
        onSelect: (index: number) => {
          state.tab = index;
        },
      });
      const right = [
        state.paused ? "paused" : state.loading ? "loading…" : `${state.range} · ${state.who}`,
        state.lastRefresh ? `updated ${ago(state.lastRefresh)}` : "starting",
        clock(),
      ].join("  ");
      header.text(`${right} `, {
        fg: state.paused ? theme.warning : state.error ? theme.danger : theme.success,
        align: "right",
      });
    });
    ui.spacer(1);

    ui.column({ size: height - 4 }, (body) => renderBody(body, state, theme));

    ui.spacer(1);
    const errorCount = state.snapshot ? Object.keys(state.snapshot.errors).length : 0;
    const onList = state.tab === 1 && !state.domain;
    ui.statusBar({
      items: [
        { key: "1-5", label: "Screen" },
        ...(onList ? [{ key: "↵", label: "Open site" }] : []),
        ...(state.domain ? [{ key: "esc", label: "Back", active: true }] : []),
        ...(onList ? [{ key: "s", label: `Sort ${state.sort}` }] : []),
        { key: "r", label: "Refresh" },
        { key: "w", label: `Window ${state.range}` },
        { key: "b", label: state.who },
        { key: "p", label: state.paused ? "Resume" : "Pause", active: state.paused },
        { key: "?", label: "Help" },
        { key: "q", label: "Quit" },
      ],
      right: errorCount
        ? [{ label: `${errorCount} source${errorCount > 1 ? "s" : ""} unavailable`, color: theme.warning }]
        : [{ label: "all sources live", color: theme.success }],
    });

    if (state.showHelp) {
      ui.modal({
        title: "CrawlProof — Spend & ROI",
        width: 76,
        height: 28,
        message:
          "1-5, Tab, ←/→ switch screens.\n" +
          `r refreshes now; it also refreshes every ${interval}s.\n` +
          "w cycles the window: 1h → 4h → 1d → 1w → 1m.\n" +
          "b cycles who counts: humans → all → bots.\n" +
          "p pauses the timer. ↑/↓ j/k, PgUp/PgDn move in a table.\n\n" +
          "On Traffic: ↑/↓ pick a site, Enter or a click opens it,\n" +
          "  Esc / ← / 2 comes back, s cycles the order:\n" +
          "  score → visitors → pageviews.\n\n" +
          "Risk-to-viral scores a property out of 100:\n" +
          "  score = 100 × viral × (1 − risk/2)\n" +
          "  viral = momentum .40 + discovery .30 + humanity .20 + money .10\n" +
          "  risk  = volatility .40 + concentration .30 + bots .20 + unmonetised .10\n" +
          "  A component with no data is dropped, not counted as zero;\n" +
          "  ~ marks too small a sample. The domain screen shows every part.\n\n" +
          "Cost is business-scope bank spend as a monthly rate, so it\n" +
          "  does not move when you change the traffic window.\n" +
          "Revenue is CoinPay commission only. Ad spend and ad earnings\n" +
          "  are the same account on both sides of our own network, so\n" +
          "  they are reported under Internal and counted as neither.\n\n" +
          "Press any key to close.",
        buttons: [{ label: "Close", focused: true }],
      });
    }
  });

  app.on("exit", () => {
    clearInterval(poll);
    clearInterval(tick);
  });

  void refresh();
  await app.start();
}
