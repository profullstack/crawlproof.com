// The program CrawlProof runs, stated once so the descriptor, the join
// answer, the dashboard and the marketing page cannot disagree. Change a
// number here and every surface follows; the spec's program.changed event
// is queued by the cron when it notices `terms` on a membership differ.
//
// Why 30 percent and not the 60 percent the 2026-06 referral header promised:
// a credits pack is spent on ads whose clicks pay publishers 1.4c of every
// 2c, so 60 percent of the pack price would be paid twice over. Thirty
// percent of a first purchase sits inside the margin that is actually ours.

import { WELL_KNOWN_PATH, type Descriptor, type Pays, type Program } from "./spec";

export const PROGRAM_ID = "partners";
export const PROGRAM_TITLE = "CrawlProof partner program";
export const PAYS: Pays[] = [{ event: "sale", kind: "percent", value: 30 }];
export const WINDOW_DAYS = 30;
export const HOLD_DAYS = 30;
export const PAYOUT_METHOD = "usdc/eip155:137";
export const PAYOUT_COINPAY_CURRENCY = "USDC_POL";
export const PAYOUT_MIN_CENTS = 1000;
export const PAYOUT_SCHEDULE = "weekly" as const;
export const DISCLOSURE = "Paid partner link";
export const CURRENCY = "USD";

/** The program as a parsed Program, for code that wants the typed shape. */
export function ourProgram(siteUrl: string): Program {
  const base = siteUrl.replace(/\/$/, "");
  return {
    id: PROGRAM_ID,
    title: PROGRAM_TITLE,
    url: `${base}/affiliate`,
    join: `${base}/api/affiliate/v1/join`,
    ledger: `${base}/api/affiliate/v1/ledger`,
    approval: "open",
    pays: PAYS,
    link: { param: "oa", template: `${base}/?oa={code}`, deep: true, aliases: [] },
    window: WINDOW_DAYS,
    attribution: "last",
    hold_days: HOLD_DAYS,
    payout: { methods: [PAYOUT_METHOD], min: PAYOUT_MIN_CENTS / 100, schedule: PAYOUT_SCHEDULE },
    disclosure: DISCLOSURE,
    self: "refused",
    creatives: `${base}/affiliate/creatives.json`,
    status: "active",
    extra: {},
  };
}

/** The JSON we serve at /.well-known/openaffiliate.json. */
export function ourDescriptorJson(siteUrl: string, updated: string): Record<string, unknown> {
  const base = siteUrl.replace(/\/$/, "");
  const p = ourProgram(siteUrl);
  return {
    merchant: {
      name: "CrawlProof",
      web: base,
      operator: `${base}/.well-known/openprofile.md`,
      currency: CURRENCY,
      terms: `${base}/affiliate/terms`,
      jwks: `${base}/.well-known/openaffiliate-jwks.json`,
    },
    updated,
    programs: [
      {
        id: p.id,
        title: p.title,
        url: p.url,
        join: p.join,
        ledger: p.ledger,
        approval: p.approval,
        pays: p.pays,
        link: { param: p.link.param, template: p.link.template, deep: p.link.deep },
        window: p.window,
        attribution: p.attribution,
        hold_days: p.hold_days,
        payout: p.payout,
        disclosure: p.disclosure,
        self: p.self,
        creatives: p.creatives,
        status: p.status,
      },
    ],
  };
}

export function ourDescriptor(siteUrl: string, updated: string): Descriptor {
  return {
    merchant: {
      name: "CrawlProof",
      web: siteUrl.replace(/\/$/, ""),
      currency: CURRENCY,
      extra: {},
    },
    updated,
    programs: [ourProgram(siteUrl)],
  };
}

export const DESCRIPTOR_PATH = WELL_KNOWN_PATH;

/** The one line of terms a person reads before joining. */
export function termsLine(): string {
  const sale = PAYS.find((p) => p.event === "sale");
  const pct = sale?.kind === "percent" ? `${sale.value}%` : sale ? `$${sale.value}` : "nothing";
  return `${pct} of every purchase for ${WINDOW_DAYS} days after the click, paid in USDC on Polygon once the ${HOLD_DAYS}-day refund window passes, from $${(PAYOUT_MIN_CENTS / 100).toFixed(0)}.`;
}
