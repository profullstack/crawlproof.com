import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanProperty, cleanReturnUrl, createAdDeposit, parseDepositRequest } from "@/lib/ads/deposits";
import { setPlatformConnectionRowLoaderForTests } from "@/lib/platform-integrations";

setPlatformConnectionRowLoaderForTests(async () => null);

// Partner ad-budget deposits as a hosted CoinPay checkout session (ad.network).

const SID = "cs_AdNetDeposit000000000001";

function fakeDb() {
  const rows: Record<string, unknown>[] = [];
  const from = () => {
    let op: "insert" | "update" = "insert";
    let payload: Record<string, unknown> = {};
    const filters: [string, unknown][] = [];
    const q: any = {
      insert: (row: Record<string, unknown>) => ((op = "insert"), (payload = { id: `pur-${rows.length + 1}`, ...row }), rows.push(payload), q),
      update: (row: Record<string, unknown>) => ((op = "update"), (payload = row), q),
      select: () => q,
      eq: (k: string, v: unknown) => (filters.push([k, v]), q),
      single: async () => ({ data: payload, error: null }),
      then: (resolve: (v: unknown) => void) => {
        if (op === "update") for (const r of rows.filter((r) => filters.every(([k, v]) => r[k] === v))) Object.assign(r, payload);
        resolve({ data: null, error: null });
      },
    };
    return q;
  };
  return { sb: { from } as any, rows };
}

let calls: { url: string; body: any }[] = [];
beforeEach(() => {
  calls = [];
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(
      JSON.stringify({
        success: true,
        id: SID,
        url: `https://stub.coinpayportal.com/checkout/${SID}`,
        status: "open",
        methods: ["USDC_POL", "BTC", "PAYPAL"],
        expires_at: "2026-10-21T14:00:00Z",
      }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
});

describe("parseDepositRequest, checkout session", () => {
  it("reads the partner's buyer, property and return URLs", () => {
    const r = parseDepositRequest({
      amount_usd: 25,
      checkout: "session",
      customer_email: "buyer@example.com",
      account_id: "5d79f032-b9ec-42b6-a34a-577c9ab9688d",
      property: "https://ad.network.pit.world/deposits",
      success_url: "https://ad.network.pit.world/deposits?deposit={CHECKOUT_SESSION_ID}",
      cancel_url: "https://ad.network.pit.world/deposits",
    });
    expect(r).toEqual({
      ok: true,
      request: {
        amountCents: 2500,
        currency: "usdc_pol",
        checkout: "session",
        customerEmail: "buyer@example.com",
        accountId: "5d79f032-b9ec-42b6-a34a-577c9ab9688d",
        property: "ad.network.pit.world",
        successUrl: "https://ad.network.pit.world/deposits?deposit={CHECKOUT_SESSION_ID}",
        cancelUrl: "https://ad.network.pit.world/deposits",
      },
    });
  });

  it("refuses a bad email, http return URL, odd property or unknown checkout", () => {
    expect(parseDepositRequest({ amount_usd: 10, checkout: "session", customer_email: "nope" })).toMatchObject({ ok: false });
    expect(parseDepositRequest({ amount_usd: 10, checkout: "session", success_url: "http://x.example/ok" })).toMatchObject({ ok: false });
    expect(parseDepositRequest({ amount_usd: 10, checkout: "session", cancel_url: "javascript:alert(1)" })).toMatchObject({ ok: false });
    expect(parseDepositRequest({ amount_usd: 10, checkout: "session", property: "not a host" })).toMatchObject({ ok: false });
    expect(parseDepositRequest({ amount_usd: 10, checkout: "card" })).toMatchObject({ ok: false });
    expect(parseDepositRequest({ amount_usd: 10, checkout: "session", account_id: "a b" })).toMatchObject({ ok: false });
  });

  it("cleans hosts and return URLs", () => {
    expect(cleanProperty("AD.network.pit.world")).toBe("ad.network.pit.world");
    expect(cleanProperty("localhost")).toBeNull();
    expect(cleanReturnUrl("https://a.example/x?s={CHECKOUT_SESSION_ID}")).toBe("https://a.example/x?s={CHECKOUT_SESSION_ID}");
    expect(cleanReturnUrl("ftp://a.example/")).toBeNull();
  });
});

describe("createAdDeposit, checkout session", () => {
  it("opens a session for the partner's buyer and keys the purchase by its id", async () => {
    const { sb, rows } = fakeDb();
    const parsed = parseDepositRequest({
      amount_usd: 25,
      checkout: "session",
      customer_email: "buyer@example.com",
      account_id: "sub-123",
      property: "ad.network.pit.world",
      success_url: "https://ad.network.pit.world/deposits?deposit={CHECKOUT_SESSION_ID}",
      cancel_url: "https://ad.network.pit.world/deposits",
    });
    if (!parsed.ok) throw new Error(parsed.error);
    const r = await createAdDeposit({ sb, userId: "house", email: "house@example.com", request: parsed.request, reference: "ad.network:sub-123" });

    expect(r).toEqual({
      ok: true,
      deposit: {
        checkout_session_id: SID,
        payment_id: SID,
        url: `https://stub.coinpayportal.com/checkout/${SID}`,
        checkout_url: `https://stub.coinpayportal.com/checkout/${SID}`,
        amount_usd: 25,
        credits: 500,
        methods: ["USDC_POL", "BTC", "PAYPAL"],
        expires_at: "2026-10-21T14:00:00Z",
        status: "open",
      },
    });
    // One call: the session. No coin is pre-picked in session mode.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://stub.coinpayportal.com/api/checkout/sessions");
    expect(calls[0].body).toMatchObject({
      amount: 25,
      currency: "USD",
      customer_email: "buyer@example.com",
      account_id: "sub-123",
      property: "ad.network.pit.world",
      success_url: "https://ad.network.pit.world/deposits?deposit={CHECKOUT_SESSION_ID}",
      cancel_url: "https://ad.network.pit.world/deposits",
    });
    expect(calls[0].body.metadata).toMatchObject({
      kind: "ad_budget",
      pack_id: "ad-budget",
      purchase_id: "pur-1",
      owner_id: "house",
      user_id: "house",
      reference: "ad.network:sub-123",
      customer_email: "buyer@example.com",
      partner_account_id: "sub-123",
      property: "ad.network.pit.world",
    });
    expect(rows[0]).toMatchObject({ owner_id: "house", pack_id: "ad-budget", credits_added: 500, amount_cents: 2500, status: "pending", coinpay_payment_id: SID });
  });

  it("falls back to the partner account email and crawlproof's return URLs", async () => {
    const { sb } = fakeDb();
    const parsed = parseDepositRequest({ amount_usd: 5, checkout: "session" });
    if (!parsed.ok) throw new Error(parsed.error);
    await createAdDeposit({ sb, userId: "house", email: "house@example.com", request: parsed.request });
    expect(calls[0].body).toMatchObject({ customer_email: "house@example.com", account_id: "house", property: "crawlproof.com" });
    expect(calls[0].body.success_url).toMatch(/\/dashboard\/settings\/billing\?purchase=success/);
  });

  it("the coin path still pre-picks the coin and answers address + amount", async () => {
    const { sb } = fakeDb();
    const parsed = parseDepositRequest({ amount_usd: 5, currency: "usdc_sol" });
    if (!parsed.ok) throw new Error(parsed.error);
    const r = await createAdDeposit({ sb, userId: "house", email: "house@example.com", request: parsed.request });
    expect(calls.map((c) => c.url)).toContain(`https://stub.coinpayportal.com/api/checkout/sessions/${SID}/select`);
    expect(r).toMatchObject({ ok: true, deposit: { payment_id: SID, currency: "usdc_sol", status: "pending" } });
  });
});
