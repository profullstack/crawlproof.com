import { describe, expect, it, vi } from "vitest";
import { depositCredits, isAdsPartner, parseDepositRequest, partnerUserIds } from "@/lib/ads/deposits";
import { createCryptoPayout } from "@/lib/coinpay";
import { cleanPayoutTarget, requestSlotPayout, slotAvailableCents } from "@/lib/ads/payouts";

vi.mock("@/lib/coinpay", () => ({
  createCryptoPayout: vi.fn(async () => ({ ok: true, payoutId: "po_1", txHash: "0xabc", status: "completed" })),
  createCheckoutSession: vi.fn(),
  selectSessionMethod: vi.fn(),
  getPaymentStatus: vi.fn(),
}));

describe("ad-budget deposits", () => {
  it("prices a deposit at ad value: $1 buys 20 credits", () => {
    expect(depositCredits(500)).toBe(100);
    expect(depositCredits(2_599)).toBe(519);
  });

  it("parses dollars and a coin, and refuses amounts out of range", () => {
    expect(parseDepositRequest({ amount_usd: 25, currency: "USDC_SOL" })).toEqual({ ok: true, request: { amountCents: 2500, currency: "usdc_sol", checkout: "coin" } });
    expect(parseDepositRequest({ amount_usd: "10" })).toEqual({ ok: true, request: { amountCents: 1000, currency: "usdc_pol", checkout: "coin" } });
    expect(parseDepositRequest({ amount_usd: 4.99 })).toMatchObject({ ok: false });
    expect(parseDepositRequest({ amount_usd: 20_000 })).toMatchObject({ ok: false });
    expect(parseDepositRequest({ amount_usd: "lots" })).toMatchObject({ ok: false });
    expect(parseDepositRequest({ amount_usd: 10, currency: "usdc pol; drop" })).toMatchObject({ ok: false });
  });

  it("only listed accounts are partners", () => {
    expect(partnerUserIds(" a, b\nc ")).toEqual(new Set(["a", "b", "c"]));
    expect(isAdsPartner("b", "a,b")).toBe(true);
    expect(isAdsPartner("z", "a,b")).toBe(false);
    expect(isAdsPartner("a", "")).toBe(false);
  });
});

/** A tiny stand-in for the service client: per-table rows, filters by eq, records writes. */
function fakeDb(tables: Record<string, Record<string, unknown>[]>) {
  const writes: { table: string; op: string; row: Record<string, unknown> }[] = [];
  const from = (table: string) => {
    const filters: [string, unknown][] = [];
    let op: "select" | "insert" | "update" = "select";
    let payload: Record<string, unknown> = {};
    const rows = () => (tables[table] ?? []).filter((r) => filters.every(([k, v]) => r[k] === v));
    const q: any = {
      select: () => q,
      eq: (k: string, v: unknown) => (filters.push([k, v]), q),
      insert: (row: Record<string, unknown>) => {
        op = "insert";
        payload = { id: `${table}-${writes.length + 1}`, ...row };
        writes.push({ table, op, row: payload });
        (tables[table] ??= []).push(payload);
        return q;
      },
      update: (row: Record<string, unknown>) => ((op = "update"), (payload = row), q),
      maybeSingle: async () => ({ data: rows()[0] ?? null }),
      single: async () => ({ data: op === "insert" ? payload : rows()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => void) => {
        if (op === "update") {
          for (const r of rows()) Object.assign(r, payload);
          writes.push({ table, op, row: payload });
        }
        resolve({ data: rows(), error: null });
      },
    };
    return q;
  };
  return { sb: { from } as any, writes, tables };
}

describe("slot payouts", () => {
  const base = () => ({
    ad_slots: [{ id: "s1", owner_id: "pub", payout_address: "0xPub", payout_currency: "usdc_pol" }],
    ad_ledger: [
      { slot_id: "s1", kind: "publisher_accrual", amount_cents: 400 },
      { slot_id: "s1", kind: "publisher_accrual", amount_cents: 300 },
    ],
    ad_payouts: [{ slot_id: "s1", amount_cents: 100, status: "confirmed" }, { slot_id: "s1", amount_cents: 999, status: "failed" }],
    credit_purchases: [{ amount_cents: 10_000, status: "complete" }],
  });

  it("available = accrued minus every withdrawal that did not fail", async () => {
    expect(await slotAvailableCents(fakeDb(base()).sb, "s1")).toBe(600);
  });

  it("uses the global destination for the actual transfer and ledger snapshot", async () => {
    const rows: Record<string, Record<string, unknown>[]> = base();
    rows.coinpay_identities = [{ user_id: "pub", coinpay_sub: "verified-sub" }];
    rows.coinpay_wallet_profiles = [{ user_id: "pub", coinpay_sub: "verified-sub", wallets: [{ id: "global", address: "global-sol-address", currency: "sol", label: null }], preferred_wallet_id: "global" }];
    const db = fakeDb(rows);
    const result = await requestSlotPayout({ sb: db.sb, userId: "pub", email: null, slotId: "s1" });
    expect(result.ok).toBe(true);
    expect(createCryptoPayout).toHaveBeenLastCalledWith(expect.objectContaining({ recipientWallet: "global-sol-address", currency: "sol" }));
    expect(db.writes.find(w => w.table === "ad_payouts")?.row).toMatchObject({ address: "global-sol-address", currency: "sol" });
  });

  it("pays the slot's wallet and writes the ledger", async () => {
    const db = fakeDb(base());
    const r = await requestSlotPayout({ sb: db.sb, userId: "pub", email: null, slotId: "s1" });
    expect(r).toEqual({ ok: true, amountCents: 600, status: "confirmed" });
    expect(db.writes.find((w) => w.table === "ad_ledger")?.row).toMatchObject({ kind: "publisher_payout", amount_cents: -600, slot_id: "s1" });
  });

  it("is scoped to the caller's own slots", async () => {
    expect(await requestSlotPayout({ sb: fakeDb(base()).sb, userId: "someone-else", email: null, slotId: "s1" })).toEqual({ ok: false, error: "Slot not found." });
  });

  it("refuses below the minimum, without a wallet, and beyond cash in", async () => {
    const small = base();
    small.ad_ledger = [{ slot_id: "s1", kind: "publisher_accrual", amount_cents: 450 }];
    expect(await requestSlotPayout({ sb: fakeDb(small).sb, userId: "pub", email: null, slotId: "s1" })).toMatchObject({ ok: false, error: expect.stringContaining("Minimum") });
    const nowallet = base();
    nowallet.ad_slots[0]!.payout_address = null as unknown as string;
    expect(await requestSlotPayout({ sb: fakeDb(nowallet).sb, userId: "pub", email: null, slotId: "s1" })).toMatchObject({ ok: false, error: expect.stringContaining("wallet") });
    const broke = base();
    broke.credit_purchases = [{ amount_cents: 500, status: "complete" }];
    expect(await requestSlotPayout({ sb: fakeDb(broke).sb, userId: "pub", email: null, slotId: "s1" })).toMatchObject({ ok: false, error: expect.stringContaining("paused") });
  });

  it("cleans a payout target; empty clears it", () => {
    expect(cleanPayoutTarget("  0xAbC ", " USDC_POL ")).toEqual({ address: "0xAbC", currency: "usdc_pol" });
    expect(cleanPayoutTarget("", "")).toEqual({ address: null, currency: null });
  });
});
