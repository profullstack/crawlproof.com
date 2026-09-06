// `crawlproof dashboard` — what the fleet costs and what it returns, live.
//
// Five screens over three feeds: CrawlProof's tracker for who arrived, its ad
// network for what was delivered, and CoinPay for what the bank actually did.
// The interesting screen is the first one, because it is the only place those
// three meet and the only place the answer is a ratio rather than a total.
//
// Built on @profullstack/hqtui, the same library behind `coinpay finances`.

import type { Container, RenderArgs, Theme } from "@profullstack/hqtui";

import { collectDashboard, type CoinPayAuth, type DashboardSnapshot } from "../lib/dashboard/collect";
import { AD_TARGET_CTR, AD_TARGET_IMPRESSIONS, adTargets } from "../lib/dashboard/roi";

export const TABS = ["ROI", "Traffic", "Ads", "Money", "Spend"] as const;
export const RANGES = ["1h", "4h", "1d", "1w", "1m"] as const;

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

type State = {
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

function trafficScreen(ui: Container, state: State, theme: Theme): void {
  const s = state.snapshot as DashboardSnapshot;
  const rows = s.sites;

  ui.grid({ columns: ["3fr", "2fr"], gap: 1 }, (grid) => {
    grid.panel(
      {
        title: `Sites · ${state.range} · ${state.who}`,
        subtitle: `${s.roi.attention.sitesReporting} of ${rows.length} reporting`,
        footer: "j/k scroll",
      },
      (p) => {
        const view = pane(state, "sites", rows.length);
        p.table({
          columns: [
            {
              key: "site",
              title: "Site",
              width: 28,
              // A site that did not answer is coloured, not silently ordinary.
              color: (row: { note?: string }) => (row.note ? theme.danger : undefined),
            },
            { key: "visitors", title: "Visitors", align: "right", width: 10 },
            { key: "pageviews", title: "Views", align: "right", width: 9 },
            { key: "cost", title: "Cost", align: "right", width: 10 },
            { key: "note", title: "", width: 16, color: theme.danger },
          ],
          rows: rows.map((row) => {
            const share = s.roi.attention.visitors > 0 ? row.visitors / s.roi.attention.visitors : 0;
            return {
              site: row.site,
              visitors: row.error ? "—" : count(row.visitors),
              pageviews: row.error ? "—" : count(row.pageviews),
              cost: row.error ? "—" : money(s.roi.cost.windowUsd * share, { cents: true }),
              note: row.error ? row.error.slice(0, 16) : "",
            };
          }),
          offset: view.offset,
          selected: view.selected,
          scrollbar: true,
          onScroll: (delta: number) => scrollPane(view, delta, 3),
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
};

export async function runDashboard(opts: DashboardOptions): Promise<void> {
  const hqtui = await loadHqtui();
  const app = await hqtui.createApp({
    fps: 30,
    theme: (opts.theme as never) || "dark",
    quitKeys: ["ctrl+c", "q"],
  });

  const state: State = {
    tab: 0,
    range: opts.range && RANGES.includes(opts.range as never) ? opts.range : "1d",
    who: opts.who ?? "humans",
    snapshot: null,
    loading: false,
    lastRefresh: null,
    error: null,
    paused: false,
    showHelp: false,
    panes: {},
    targetImpressions: opts.targetImpressions ?? AD_TARGET_IMPRESSIONS,
    targetCtr: opts.targetCtr ?? AD_TARGET_CTR,
  };

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

  app.on("key", (event: { name: string; shift?: boolean }) => {
    if (state.showHelp) {
      state.showHelp = false;
      app.invalidate();
      return;
    }
    const digit = Number(event.name);
    if (Number.isInteger(digit) && event.name.length === 1 && digit >= 1 && digit <= TABS.length) {
      state.tab = digit - 1;
      app.invalidate();
      return;
    }
    const view = pane(state, TAB_PANE[state.tab] as string, state.panes[TAB_PANE[state.tab] as string]?.total ?? 0);
    switch (event.name) {
      case "tab":
      case "right":
      case "l":
        state.tab = event.shift ? (state.tab + TABS.length - 1) % TABS.length : (state.tab + 1) % TABS.length;
        break;
      case "left":
      case "h":
        state.tab = (state.tab + TABS.length - 1) % TABS.length;
        break;
      case "r":
      case "f5":
        void refresh();
        break;
      case "w":
        state.range = RANGES[(RANGES.indexOf(state.range as never) + 1) % RANGES.length] as string;
        void refresh();
        break;
      case "b":
        state.who = state.who === "humans" ? "all" : state.who === "all" ? "bots" : "humans";
        void refresh();
        break;
      case "p":
      case "space":
        state.paused = !state.paused;
        break;
      case "?":
      case "f1":
        state.showHelp = true;
        break;
      case "up":
      case "k":
        scrollPane(view, -1);
        break;
      case "down":
      case "j":
        scrollPane(view, 1);
        break;
      case "pageup":
        scrollPane(view, -1, 10);
        break;
      case "pagedown":
        scrollPane(view, 1, 10);
        break;
      default:
        return;
    }
    app.invalidate();
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

    ui.column({ size: height - 4 }, (body) => {
      if (!state.snapshot) {
        body.panel({ title: "Spend & ROI" }, (p) => {
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
      (SCREENS[state.tab] ?? roiScreen)(body, state, theme);
    });

    ui.spacer(1);
    const errorCount = state.snapshot ? Object.keys(state.snapshot.errors).length : 0;
    ui.statusBar({
      items: [
        { key: "1-5", label: "Screen" },
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
        width: 70,
        height: 22,
        message:
          "1-5, Tab, ←/→ switch screens.\n" +
          `r refreshes now; it also refreshes every ${interval}s.\n` +
          "w cycles the window: 1h → 4h → 1d → 1w → 1m.\n" +
          "b cycles who counts: humans → all → bots.\n" +
          "p pauses the timer. ↑/↓ j/k, PgUp/PgDn scroll a table.\n\n" +
          "Cost is business-scope bank spend as a monthly rate, so it\n" +
          "  does not move when you change the traffic window.\n" +
          "Revenue is CoinPay commission only. Ad spend and ad earnings\n" +
          "  are the same account on both sides of our own network, so\n" +
          "  they are reported under Internal and counted as neither.\n" +
          "Cost each = the monthly burn prorated onto the window,\n" +
          "  divided by the visitors who arrived in it.\n\n" +
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
