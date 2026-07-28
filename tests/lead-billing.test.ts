import { describe, it, expect, vi, beforeEach } from "vitest";
import { manualRunPrice, LEAD_RUN_CREDITS, LEADS_PER_CHARGE } from "@/lib/credits";

const consumeCredit = vi.fn();
const refundCredit = vi.fn();

vi.mock("@/lib/rateLimit", () => ({
  consumeCredit: (...a: unknown[]) => consumeCredit(...a),
  refundCredit: (...a: unknown[]) => refundCredit(...a),
}));

const { leadRunBilling, outOfCreditsNote } = await import("@/lib/outreach/billing");

beforeEach(() => {
  consumeCredit.mockReset().mockResolvedValue({ ok: true });
  refundCredit.mockReset().mockResolvedValue(undefined);
});

describe("manualRunPrice", () => {
  it("charges one unit for a run inside the first block", () => {
    expect(manualRunPrice(LEADS_PER_CHARGE).credits).toBe(LEAD_RUN_CREDITS);
    expect(manualRunPrice(1).credits).toBe(LEAD_RUN_CREDITS);
  });

  it("never gives a run away, however small", () => {
    // Rounding down would make a one-lead run free, and a one-lead run still
    // pays for a search.
    expect(manualRunPrice(0).credits).toBe(LEAD_RUN_CREDITS);
  });

  it("scales with the size asked for", () => {
    // Ten times the leads is ten times the paid search behind them; charging
    // the same would make the biggest runs the cheapest place to spend on us.
    expect(manualRunPrice(1000).credits).toBe(10 * LEAD_RUN_CREDITS);
  });

  it("rounds a part-block up", () => {
    expect(manualRunPrice(LEADS_PER_CHARGE + 1).credits).toBe(2 * LEAD_RUN_CREDITS);
  });

  it("buys search budget in proportion to the charge", () => {
    const small = manualRunPrice(LEADS_PER_CHARGE);
    const large = manualRunPrice(LEADS_PER_CHARGE * 10);
    expect(large.contactSearches / small.contactSearches).toBe(
      large.credits / small.credits,
    );
  });
});

describe("leadRunBilling", () => {
  it("charges once however many stages ask", async () => {
    // A tick's stages each check before spending; the user bought one run.
    const b = leadRunBilling("owner-1");
    expect(await b.authorize()).toBe(true);
    expect(await b.authorize()).toBe(true);
    expect(await b.authorize()).toBe(true);
    expect(consumeCredit).toHaveBeenCalledTimes(1);
    expect(consumeCredit).toHaveBeenCalledWith("owner-1", LEAD_RUN_CREDITS);
  });

  it("does not charge a tick that never asks", async () => {
    // The cron fires every fifteen minutes. Billing an idle campaign per tick
    // would cost 288 credits a day to leave switched on.
    leadRunBilling("owner-1");
    expect(consumeCredit).not.toHaveBeenCalled();
  });

  it("stops asking once the balance has declined", async () => {
    consumeCredit.mockResolvedValue({ ok: false });
    const b = leadRunBilling("owner-1");
    expect(await b.authorize()).toBe(false);
    expect(await b.authorize()).toBe(false);
    // Retrying per stage would hammer the balance check for a campaign that
    // has simply run out.
    expect(consumeCredit).toHaveBeenCalledTimes(1);
    expect(b.declined()).toBe(true);
    expect(b.charged()).toBe(false);
  });

  it("refunds what it charged", async () => {
    const b = leadRunBilling("owner-1");
    await b.authorize();
    await b.refund();
    expect(refundCredit).toHaveBeenCalledWith("owner-1", LEAD_RUN_CREDITS);
    expect(b.charged()).toBe(false);
  });

  it("refunds nothing when nothing was charged", async () => {
    // A refund path that fires without a charge is free credits.
    const b = leadRunBilling("owner-1");
    await b.refund();
    expect(refundCredit).not.toHaveBeenCalled();
  });

  it("does not refund twice", async () => {
    const b = leadRunBilling("owner-1");
    await b.authorize();
    await b.refund();
    await b.refund();
    expect(refundCredit).toHaveBeenCalledTimes(1);
  });

  it("honours a custom price, for runs charged by size", async () => {
    const b = leadRunBilling("owner-1", 30);
    await b.authorize();
    expect(consumeCredit).toHaveBeenCalledWith("owner-1", 30);
  });

  it("names the price in the out-of-credits note", async () => {
    // It lands in the run history, which is the only place a paused campaign
    // gets to explain itself.
    expect(outOfCreditsNote()).toContain(String(LEAD_RUN_CREDITS));
    expect(outOfCreditsNote()).toMatch(/billing/i);
  });
});

describe("the meter is actually connected", () => {
  // The price sat in the source as an unreferenced constant for a while, so
  // every campaign tick and every manual search ran free. A unit test of the
  // pricing function would have passed the whole time it was broken — the bug
  // was that nobody called it. These read the source instead.
  const read = async (p: string) =>
    (await import("node:fs")).readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

  it("charges the campaign tick", async () => {
    const src = await read("lib/outreach/runner.ts");
    expect(src).toContain("leadRunBilling");
  });

  it("gates discovery, the most expensive stage, on being able to pay", async () => {
    const src = await read("lib/outreach/runner.ts");
    const discovery = src.slice(src.indexOf("---- 4. Top the funnel up"));
    expect(discovery.slice(0, 400)).toMatch(/canSpend\(\)/);
  });

  it("charges the manual finder", async () => {
    const src = await read("app/actions/leads.ts");
    expect(src).toContain("manualRunPrice");
    expect(src).toContain("leadRunBilling");
  });

  it("sizes the manual search budget by what was paid for", async () => {
    // Not by the request size: that is what let a thousand-lead run buy a
    // hundred lookups for the price of ten.
    const src = await read("app/actions/leads.ts");
    expect(src).toContain("remaining: price.contactSearches");
  });
});
