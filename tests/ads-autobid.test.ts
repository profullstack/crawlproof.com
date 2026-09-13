import { describe, expect, it } from "vitest";
import {
  AUTOBID_MAX_CREDITS,
  AUTOBID_MIN_CREDITS,
  PAPER_EXHAUSTED_WEIGHT,
  decideBid,
  isPaperBudgetReached,
  lowerBid,
  maxAutobidCredits,
  medianBid,
  paperWeight,
  raiseBid,
  utcDayFraction,
  type AutobidInput,
} from "@/lib/ads/autobid";
import { foldBidHistory, runAutobidSweep } from "@/lib/ads/bids";
import { CREDIT_CENTS } from "@/lib/ads/pricing";

// The bid is automatic: an advertiser sets a daily budget and a pacing
// controller sets the bid from it, hourly. These cases pin the rules that
// decide a bid, the paper tier that gives the free-tier lottery something to
// pace, the carry-forward that turns a sparse decision log into a daily
// series, and the sweep's writes.

const input = (over: Partial<AutobidInput> = {}): AutobidInput => ({
  bidCredits: 4,
  dailyBudgetCents: 500, // $5 = 100 credits
  spentTodayCents: 0,
  dayFraction: 0.5,
  impressions24h: 100,
  clicks24h: 2,
  competitors: 10,
  marketBidCredits: 4,
  ...over,
});

describe("maxAutobidCredits", () => {
  it("buys at least five clicks from the day's budget", () => {
    // 100 credits / 5 clicks = 20 credits a click
    expect(maxAutobidCredits(500)).toBe(20);
    // $1 = 20 credits → 4 a click
    expect(maxAutobidCredits(100)).toBe(4);
  });
  it("never goes under the floor or over the ceiling", () => {
    expect(maxAutobidCredits(0)).toBe(AUTOBID_MIN_CREDITS);
    expect(maxAutobidCredits(10)).toBe(AUTOBID_MIN_CREDITS);
    expect(maxAutobidCredits(1_000_000)).toBe(AUTOBID_MAX_CREDITS);
  });
});

describe("raiseBid / lowerBid", () => {
  it("moves at least one credit each way", () => {
    expect(raiseBid(1, 20)).toBe(2);
    expect(lowerBid(2, 20)).toBe(1);
  });
  it("moves a quarter up and a fifth down on larger bids", () => {
    expect(raiseBid(8, 40)).toBe(10);
    expect(lowerBid(10, 40)).toBe(8);
  });
  it("respects the cap and the floor", () => {
    expect(raiseBid(20, 20)).toBe(20);
    expect(lowerBid(1, 20)).toBe(1);
  });
});

describe("decideBid", () => {
  it("raises a campaign behind its daily pace", () => {
    // Half the day gone, nothing spent: well under 70% of the expected $2.50.
    const d = decideBid(input({ spentTodayCents: 0 }));
    expect(d.reason).toBe("behind_pace");
    expect(d.bidCredits).toBe(5);
    expect(d.changed).toBe(true);
    expect(d.signals.paceRatio).toBe(0);
  });

  it("lowers a campaign ahead of pace", () => {
    // Half the day gone, $4 of $5 spent: 160% of expected.
    const d = decideBid(input({ bidCredits: 10, spentTodayCents: 400 }));
    expect(d.reason).toBe("ahead_of_pace");
    expect(d.bidCredits).toBe(8);
  });

  it("holds a campaign on pace", () => {
    const d = decideBid(input({ spentTodayCents: 250 }));
    expect(d.reason).toBe("on_pace");
    expect(d.bidCredits).toBe(4);
    expect(d.changed).toBe(false);
  });

  it("does not move before the day has said anything", () => {
    const d = decideBid(input({ dayFraction: 0.02 }));
    expect(d.reason).toBe("early_day");
    expect(d.changed).toBe(false);
  });

  it("pulls a bid down under a lowered budget at any hour", () => {
    // $1/day caps at 4 credits; a bid of 10 is over it even at 01:00.
    const d = decideBid(input({ bidCredits: 10, dailyBudgetCents: 100, dayFraction: 0.02 }));
    expect(d.reason).toBe("capped_by_budget");
    expect(d.bidCredits).toBe(4);
  });

  it("bids the floor with no budget so the campaign still rotates", () => {
    const d = decideBid(input({ dailyBudgetCents: 0 }));
    expect(d.reason).toBe("no_budget");
    expect(d.bidCredits).toBe(AUTOBID_MIN_CREDITS);
  });

  it("never raises past what the budget covers", () => {
    const d = decideBid(input({ bidCredits: 20, spentTodayCents: 0 }));
    // 20 is the cap for $5/day; behind pace but nowhere to go.
    expect(d.bidCredits).toBe(20);
    expect(d.changed).toBe(false);
  });

  it("holds once today's budget is reached instead of chasing it", () => {
    const d = decideBid(input({ spentTodayCents: 490 }));
    expect(d.reason).toBe("budget_reached");
    expect(d.changed).toBe(false);
  });

  it("raises a campaign winning nothing below the market", () => {
    const d = decideBid(input({ impressions24h: 0, marketBidCredits: 8, spentTodayCents: 250 }));
    expect(d.reason).toBe("outbid");
    expect(d.bidCredits).toBe(5);
  });

  it("stops raising when already well above the market and still behind", () => {
    // Twice the median and still under pace: inventory, not the bid, is short.
    const d = decideBid(input({ bidCredits: 8, marketBidCredits: 4, spentTodayCents: 0 }));
    expect(d.reason).toBe("inventory_limited");
    expect(d.changed).toBe(false);
  });

  it("carries every input into the signals it records", () => {
    const d = decideBid(input({ competitors: 33 }));
    expect(d.signals.competitors).toBe(33);
    expect(d.signals.maxBidCredits).toBe(20);
  });
});

describe("medianBid", () => {
  it("is the middle value, or the mean of the two middles", () => {
    expect(medianBid([1, 9, 4])).toBe(4);
    expect(medianBid([1, 2, 3, 10])).toBe(2.5);
    expect(medianBid([])).toBe(0);
  });
});

describe("utcDayFraction", () => {
  it("is the share of the UTC day elapsed", () => {
    expect(utcDayFraction(new Date("2026-09-13T12:00:00Z"))).toBeCloseTo(0.5, 5);
    expect(utcDayFraction(new Date("2026-09-13T00:00:00Z"))).toBe(0);
  });
});

describe("paper tier", () => {
  const TODAY = "2026-09-13";
  const c = (over = {}) => ({
    bid_credits: 4,
    daily_budget_cents: 100,
    paper_spend_today_cents: 0,
    paper_spend_date: TODAY,
    ...over,
  });

  it("weights a campaign with paper budget left by its bid", () => {
    expect(paperWeight(c(), TODAY)).toBe(4);
    expect(paperWeight(c({ bid_credits: 12, daily_budget_cents: 500 }), TODAY)).toBe(12);
  });

  it("drops to a token weight once the paper budget is spent", () => {
    // $1 budget, 80c spent, next click at 4 credits is 20c → 100c, which fits.
    expect(isPaperBudgetReached(c({ paper_spend_today_cents: 80 }), TODAY)).toBe(false);
    // 85c spent: one more click would be 105c.
    expect(isPaperBudgetReached(c({ paper_spend_today_cents: 85 }), TODAY)).toBe(true);
    expect(paperWeight(c({ paper_spend_today_cents: 85 }), TODAY)).toBe(PAPER_EXHAUSTED_WEIGHT);
  });

  it("forgets yesterday's spend", () => {
    expect(paperWeight(c({ paper_spend_today_cents: 999, paper_spend_date: "2026-09-12" }), TODAY)).toBe(4);
  });

  it("uses the token weight with no budget at all", () => {
    expect(paperWeight(c({ daily_budget_cents: 0 }), TODAY)).toBe(PAPER_EXHAUSTED_WEIGHT);
  });
});

describe("foldBidHistory", () => {
  const axis = ["2026-09-10", "2026-09-11", "2026-09-12", "2026-09-13"];
  const row = (day: string, over: Record<string, unknown> = {}) => ({
    day,
    impressions: 0,
    won_bid: null,
    clicks: 0,
    paper_cents: 0,
    spent_cents: 0,
    bid: null,
    ...over,
  });

  it("carries the bid forward across days that recorded none", () => {
    const out = foldBidHistory({
      axis,
      days: [row("2026-09-11", { bid: 6 })],
      visitsByDay: new Map(),
      bidBefore: 4,
      currentBid: 6,
    });
    expect(out.map((d) => d.bidCredits)).toEqual([4, 6, 6, 6]);
  });

  it("backfills days before the first record with that record", () => {
    const out = foldBidHistory({
      axis,
      days: [row("2026-09-12", { bid: 5 })],
      visitsByDay: new Map(),
      bidBefore: null,
      currentBid: 5,
    });
    expect(out.map((d) => d.bidCredits)).toEqual([5, 5, 5, 5]);
  });

  it("uses the current bid throughout when nothing was ever recorded", () => {
    const out = foldBidHistory({ axis, days: [], visitsByDay: new Map(), bidBefore: null, currentBid: 3 });
    expect(out.every((d) => d.bidCredits === 3)).toBe(true);
  });

  it("joins delivery, paper cost and tracked visits onto the same day", () => {
    const out = foldBidHistory({
      axis,
      days: [row("2026-09-13", { impressions: "120", clicks: 3, paper_cents: 60, won_bid: "4.50" })],
      visitsByDay: new Map([["2026-09-13", 2]]),
      bidBefore: 4,
      currentBid: 4,
    });
    const last = out[3];
    expect(last.impressions).toBe(120);
    expect(last.clicks).toBe(3);
    expect(last.paperCents).toBe(60);
    expect(last.visits).toBe(2);
    expect(last.wonBidCredits).toBe(4.5);
    expect(out[0].visits).toBe(0);
  });
});

// A stand-in client that answers the sweep's four reads from fixtures and
// records its writes. The sweep only ever calls from().select()… chains that
// end in a thenable and rpc(), so a small Proxy covers it.
function sweepClient(fixtures: {
  campaigns: Record<string, unknown>[];
  creatives: Record<string, unknown>[];
  activity: Record<string, unknown>[];
}) {
  const writes: { table: string; op: string; payload: unknown; filters: unknown[] }[] = [];
  const chain = (table: string, op: string, payload: unknown, data: unknown) => {
    const filters: unknown[] = [];
    const c: any = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            if (op !== "select") writes.push({ table, op, payload, filters });
            return (res: (v: unknown) => void) => Promise.resolve({ data, error: null }).then(res);
          }
          return (...args: unknown[]) => {
            filters.push([prop, ...args]);
            return c;
          };
        },
      },
    );
    return c;
  };
  const client: any = {
    from(table: string) {
      return {
        select: () =>
          chain(
            table,
            "select",
            null,
            table === "ad_campaigns" ? fixtures.campaigns : table === "ad_creatives" ? fixtures.creatives : [],
          ),
        update: (payload: unknown) => chain(table, "update", payload, null),
        insert: (payload: unknown) => chain(table, "insert", payload, null),
      };
    },
    rpc: async () => ({ data: fixtures.activity, error: null }),
  };
  return { client, writes };
}

describe("runAutobidSweep", () => {
  const NOON = new Date("2026-09-13T12:00:00Z");
  const campaign = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    owner_id: "owner",
    status: "active",
    autobid: true,
    bid_credits: 4,
    daily_budget_cents: 500,
    spend_today_cents: 0,
    spend_date: null,
    paper_spend_today_cents: 0,
    paper_spend_date: null,
    bid_updated_at: null,
    ...over,
  });

  it("seeds a first row, then writes the decision and the new bid", async () => {
    const { client, writes } = sweepClient({
      campaigns: [campaign("c1")],
      creatives: [{ campaign_id: "c1", format: "banner_300x250" }],
      activity: [{ campaign_id: "c1", impressions: 50, clicks: 1 }],
    });
    const r = await runAutobidSweep(client, NOON);
    expect(r).toEqual({ considered: 1, changed: 1, seeded: 1, held: 0 });

    const update = writes.find((w) => w.table === "ad_campaigns" && w.op === "update");
    expect(update?.payload).toMatchObject({ bid_credits: 5 });

    const insert = writes.find((w) => w.table === "ad_bids");
    const rows = insert?.payload as Record<string, unknown>[];
    expect(rows.map((x) => [x.source, x.bid_credits, x.prev_bid_credits])).toEqual([
      ["seed", 4, null],
      ["auto", 5, 4],
    ]);
    expect((rows[1].signals as Record<string, unknown>).competitors).toBe(1);
    expect(rows[1].reason).toBe("behind_pace");
  });

  it("writes nothing for a campaign held within the last day", async () => {
    const { client, writes } = sweepClient({
      campaigns: [campaign("c1", { spend_today_cents: 250, spend_date: "2026-09-13", bid_updated_at: "2026-09-13T10:00:00Z" })],
      creatives: [],
      activity: [],
    });
    const r = await runAutobidSweep(client, NOON);
    expect(r.held).toBe(1);
    expect(writes).toHaveLength(0);
  });

  it("logs a held bid once a day so the chart keeps a point", async () => {
    const { client, writes } = sweepClient({
      campaigns: [campaign("c1", { spend_today_cents: 250, spend_date: "2026-09-13", bid_updated_at: "2026-09-11T10:00:00Z" })],
      creatives: [],
      activity: [],
    });
    await runAutobidSweep(client, NOON);
    const insert = writes.find((w) => w.table === "ad_bids");
    expect((insert?.payload as Record<string, unknown>[])[0]).toMatchObject({ source: "auto", reason: "on_pace", bid_credits: 4 });
    expect(writes.some((w) => w.table === "ad_campaigns" && w.op === "update")).toBe(true);
  });

  it("counts paper spend against the pace like real spend", async () => {
    // $5/day, noon: expected $2.50. Paper spend of $2.50 is on pace.
    const { client } = sweepClient({
      campaigns: [campaign("c1", { paper_spend_today_cents: 250, paper_spend_date: "2026-09-13", bid_updated_at: "2026-09-13T11:00:00Z" })],
      creatives: [],
      activity: [],
    });
    const r = await runAutobidSweep(client, NOON);
    expect(r.changed).toBe(0);
    expect(r.held).toBe(1);
  });

  it("finds the market among campaigns sharing a format", async () => {
    const { client, writes } = sweepClient({
      campaigns: [
        campaign("c1", { bid_credits: 2, bid_updated_at: "2026-09-13T11:00:00Z" }),
        campaign("c2", { bid_credits: 10, bid_updated_at: "2026-09-13T11:00:00Z" }),
        campaign("c3", { bid_credits: 10, bid_updated_at: "2026-09-13T11:00:00Z" }),
      ],
      creatives: [
        { campaign_id: "c1", format: "text_link" },
        { campaign_id: "c2", format: "text_link" },
        { campaign_id: "c3", format: "text_link" },
      ],
      // c1 won nothing while bidding under the market: outbid.
      activity: [
        { campaign_id: "c2", impressions: 40, clicks: 0 },
        { campaign_id: "c3", impressions: 40, clicks: 0 },
      ],
    });
    await runAutobidSweep(client, NOON);
    const rows = (writes.find((w) => w.table === "ad_bids")?.payload ?? []) as Record<string, unknown>[];
    const c1 = rows.find((x) => x.campaign_id === "c1")!;
    expect(c1.reason).toBe("outbid");
    expect((c1.signals as Record<string, unknown>).competitors).toBe(3);
    expect((c1.signals as Record<string, unknown>).marketBidCredits).toBe(10);
  });

  it("reports a failed read and writes nothing", async () => {
    const client: any = {
      from: () => ({ select: () => ({ in: () => ({ eq: () => ({ limit: async () => ({ data: null, error: { message: "boom" } }) }) }) }) }),
      rpc: async () => ({ data: [], error: null }),
    };
    const r = await runAutobidSweep(client, NOON);
    expect(r.failed).toMatch(/ad_campaigns: boom/);
    expect(r.considered).toBe(0);
  });
});

describe("credit arithmetic the UI relies on", () => {
  it("prices a bid at rack", () => {
    expect(4 * CREDIT_CENTS).toBe(20);
  });
});
