import { beforeEach, describe, expect, it, vi } from "vitest";
import { CREDIT_PACKS } from "@/lib/credits";

const mocks = vi.hoisted(() => ({
  insert: vi.fn(),
  update: vi.fn(),
  createPayment: vi.fn(),
  getUser: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: mocks.getUser } }),
}));
vi.mock("@/lib/supabase/service", () => ({
  serviceClient: () => ({
    from: () => ({ insert: mocks.insert, update: mocks.update }),
  }),
}));
vi.mock("@/lib/coinpay", () => ({ createPayment: mocks.createPayment }));
vi.mock("@/lib/affiliate/attribution", () => ({ attributeUser: vi.fn() }));

import { POST } from "@/app/api/credits/create-invoice/route";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getUser.mockResolvedValue({ data: { user: { id: "buyer", email: "buyer@example.com" } } });
  mocks.insert.mockReturnValue({ select: () => ({ single: async () => ({ data: { id: "purchase" }, error: null }) }) });
  mocks.update.mockReturnValue({ eq: async () => ({ error: null }) });
  mocks.createPayment.mockResolvedValue({ paymentId: "payment", hostedUrl: "https://coinpayportal.com/pay/payment" });
});

describe.each(["card", "usdc"])("%s credit checkout", (currency) => {
  it.each(CREDIT_PACKS)("stores and bills the current $id quote, ignoring a supplied old price", async (pack) => {
    const response = await POST(new Request("https://crawlproof.com/api/credits/create-invoice", {
      method: "POST",
      body: JSON.stringify({ packId: pack.id, currency, amountCents: 100, credits: 999999 }),
    }));
    expect(response.status).toBe(200);
    expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({
      pack_id: pack.id, amount_cents: pack.amountCents, credits_added: pack.credits,
    }));
    expect(mocks.createPayment).toHaveBeenCalledWith(expect.objectContaining({
      amountCents: pack.amountCents, credits: pack.credits, currency,
    }));
  });
});

it("does not create a purchase for an unknown pack", async () => {
  const response = await POST(new Request("https://crawlproof.com/api/credits/create-invoice", {
    method: "POST", body: JSON.stringify({ packId: "retired", currency: "card" }),
  }));
  expect(response.status).toBe(400);
  expect(mocks.insert).not.toHaveBeenCalled();
  expect(mocks.createPayment).not.toHaveBeenCalled();
});
