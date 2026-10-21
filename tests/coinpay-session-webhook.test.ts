import { beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";

// An in-memory credit_purchases + profiles, with credit_purchase_complete
// behaving like the SQL function (no-op on a complete row).
type Row = { id: string; owner_id: string; coinpay_payment_id: string | null; status: string; credits_added: number };
const db = vi.hoisted(() => ({
  rows: [] as Row[],
  balance: new Map<string, number>(),
  rpcCalls: [] as string[],
}));

function table(name: string) {
  const filters: [string, unknown, boolean][] = [];
  let patch: Record<string, unknown> | null = null;
  const match = () =>
    (name === "credit_purchases" ? db.rows : []).filter((r) =>
      filters.every(([k, v, neg]) => ((r as Record<string, unknown>)[k] === v) !== neg),
    );
  const q = {
    select: () => q,
    update: (p: Record<string, unknown>) => ((patch = p), q),
    eq: (k: string, v: unknown) => (filters.push([k, v, false]), q),
    neq: (k: string, v: unknown) => (filters.push([k, v, true]), q),
    maybeSingle: async () => ({ data: match()[0] ?? null, error: null }),
    then: (resolve: (v: unknown) => void) => {
      if (patch) for (const r of match()) Object.assign(r, patch);
      resolve({ error: null });
    },
  };
  return q;
}

vi.mock("@/lib/supabase/service", () => ({
  serviceClient: () => ({
    from: table,
    rpc: async (fn: string, args: { p_payment_id: string }) => {
      db.rpcCalls.push(`${fn}:${args.p_payment_id}`);
      if (fn === "credit_purchase_complete") {
        const r = db.rows.find((x) => x.coinpay_payment_id === args.p_payment_id);
        if (r && r.status !== "complete") {
          r.status = "complete";
          db.balance.set(r.owner_id, (db.balance.get(r.owner_id) ?? 0) + r.credits_added);
        }
      }
      return { data: null, error: null };
    },
    auth: { admin: { getUserById: async () => ({ data: { user: null } }) } },
  }),
}));
vi.mock("@/lib/email", () => ({ sendPurchaseReceiptEmail: vi.fn(async () => ({ sent: false })) }));
vi.mock("@/lib/affiliate/attribution", () => ({ recordPurchaseConversion: vi.fn(async () => undefined) }));

import { POST } from "@/app/api/coinpay/webhook/route";

const SECRET = process.env.COINPAY_WEBHOOK_SECRET!;
const SID = "cs_Ju1h16BXSobdRs7XWg9MUIj0";
const PURCHASE = "11111111-2222-3333-4444-555555555555";

function signed(body: unknown) {
  const raw = JSON.stringify(body);
  const t = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac("sha256", SECRET).update(`${t}.${raw}`).digest("hex");
  return new Request("https://crawlproof.com/api/coinpay/webhook", {
    method: "POST",
    headers: { "x-coinpay-signature": `t=${t},v1=${v1}`, "content-type": "application/json" },
    body: raw,
  });
}

const event = (type: string, status: string, extra: Record<string, unknown> = {}) => ({
  id: `evt_pay_session_${type}`,
  type,
  data: {
    payment_id: "pay_session_1",
    status,
    amount: 10,
    amount_usd: 10,
    checkout_session_id: SID,
    customer_email: "buyer@example.com",
    account_id: "owner-1",
    property: "crawlproof.com",
    metadata: { purchase_id: PURCHASE },
    ...extra,
  },
});

beforeEach(() => {
  db.rows = [
    { id: PURCHASE, owner_id: "owner-1", coinpay_payment_id: SID, status: "pending", credits_added: 100 },
    { id: "legacy", owner_id: "owner-2", coinpay_payment_id: "legacy-pay", status: "pending", credits_added: 20 },
  ];
  db.balance.clear();
  db.rpcCalls = [];
  globalThis.fetch = vi.fn(async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
});

describe("CoinPay webhook, checkout sessions", () => {
  it("settles the purchase by checkout_session_id, not the payment id", async () => {
    const res = await POST(signed(event("payment.confirmed", "confirmed")));
    expect(res.status).toBe(200);
    expect(db.rpcCalls).toContain(`credit_purchase_complete:${SID}`);
    expect(db.rows[0].status).toBe("complete");
    expect(db.balance.get("owner-1")).toBe(100);
  });

  it("credits once across confirmed, forwarded and a replay", async () => {
    await POST(signed(event("payment.confirmed", "confirmed")));
    await POST(signed(event("payment.forwarded", "forwarded")));
    await POST(signed(event("payment.confirmed", "confirmed")));
    expect(db.balance.get("owner-1")).toBe(100);
  });

  it("falls back to metadata.purchase_id when the session id is missing", async () => {
    const e = event("payment.confirmed", "confirmed");
    delete (e.data as Record<string, unknown>).checkout_session_id;
    await POST(signed(e));
    expect(db.balance.get("owner-1")).toBe(100);
  });

  it("settles a PayPal capture (payment.confirmed, status completed, rail paypal)", async () => {
    const res = await POST(signed(event("payment.confirmed", "completed", { rail: "paypal", property: "ad.network.pit.world", metadata: { purchase_id: PURCHASE, kind: "ad_budget" } })));
    expect(res.status).toBe(200);
    expect(db.rows[0].status).toBe("complete");
    expect(db.balance.get("owner-1")).toBe(100);
  });

  it("settles on forwarded alone (a failed confirmed is not retried)", async () => {
    await POST(signed(event("payment.forwarded", "forwarded")));
    expect(db.balance.get("owner-1")).toBe(100);
  });

  it("does not fail the purchase when one coin attempt expires", async () => {
    const res = await POST(signed(event("payment.expired", "expired")));
    expect(res.status).toBe(200);
    expect(db.rows[0].status).toBe("pending");
  });

  it("acks a pending event without settling", async () => {
    const res = await POST(signed(event("payment.pending", "pending")));
    expect(res.status).toBe(200);
    expect(db.rpcCalls).toEqual([]);
    expect(db.rows[0].status).toBe("pending");
  });

  it("answers 200 for an unknown session and settles nothing", async () => {
    const res = await POST(
      signed(event("payment.confirmed", "confirmed", { checkout_session_id: "cs_unknownunknownunknown00", metadata: {} })),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ settled: false });
    expect(db.balance.size).toBe(0);
  });

  it("still settles a legacy payment by payment_id", async () => {
    await POST(signed({ id: "evt_legacy", type: "payment.confirmed", data: { payment_id: "legacy-pay", status: "confirmed" } }));
    expect(db.balance.get("owner-2")).toBe(20);
  });

  it("rejects a bad signature", async () => {
    const req = new Request("https://crawlproof.com/api/coinpay/webhook", {
      method: "POST",
      headers: { "x-coinpay-signature": "t=1,v1=00" },
      body: JSON.stringify(event("payment.confirmed", "confirmed")),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(db.balance.size).toBe(0);
  });
});
