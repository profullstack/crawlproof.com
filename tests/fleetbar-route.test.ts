import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { crawlproofFleetbarHandler, fleetbarUserFor } from "../lib/fleetbar";

/** Just enough of a Supabase client for coinpay_identities lookups by user. */
function fakeService(identities: Record<string, string>) {
  return (() => ({
    from: () => ({
      select: () => ({
        eq: (_col: string, userId: string) => ({
          maybeSingle: async () => ({
            data: identities[userId] ? { user_id: userId, coinpay_sub: identities[userId], coinpay_email: null, created_via: "signup" } : null,
            error: null,
          }),
        }),
      }),
    }),
  })) as unknown as () => SupabaseClient;
}

describe("crawlproof /api/fleetbar", () => {
  it("a confirmed real email goes up as the email; a linked CoinPay sub too", async () => {
    const svc = fakeService({ u1: "sub-1" });
    expect(await fleetbarUserFor({ id: "u1", email: "ann@example.com", email_confirmed_at: "2026-01-01" }, svc)).toEqual({
      email: "ann@example.com",
      emailVerified: true,
      coinpaySub: "sub-1",
    });
  });

  it("a CoinPay-created account sends only its sub, never the placeholder email", async () => {
    const u = await fleetbarUserFor(
      { id: "u2", email: "cp-abc@coinpay-users.crawlproof.com", email_confirmed_at: "2026-01-01" },
      fakeService({ u2: "sub-2" }),
    );
    expect(u).toEqual({ email: undefined, emailVerified: false, coinpaySub: "sub-2" });
  });

  it("signed out is 401 before anything else runs", async () => {
    const handler = crawlproofFleetbarHandler({ getSessionUser: async () => null, service: fakeService({}) });
    const r = await handler(new Request("https://crawlproof.com/api/fleetbar/monitors", { headers: { host: "crawlproof.com" } }));
    expect(r.status).toBe(401);
  });

  it("only the fleetbar routes exist", async () => {
    const handler = crawlproofFleetbarHandler({
      getSessionUser: async () => ({ id: "u1", email: "ann@example.com", email_confirmed_at: "x" }),
      service: fakeService({}),
    });
    const r = await handler(new Request("https://crawlproof.com/api/fleetbar/admin", { headers: { host: "crawlproof.com" } }));
    expect(r.status).toBe(404);
  });
});
