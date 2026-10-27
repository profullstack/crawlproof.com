import { describe, expect, it } from "vitest";
import { MAX_GRANT_CENTS, parseGrantRequest } from "@/lib/ads/grants";

describe("partner ad credit grants", () => {
  it("prices a grant at ad value and needs a reference", () => {
    expect(parseGrantRequest({ amount_usd: 5, reference: "code:crd_1:sub-1" })).toEqual({
      ok: true,
      request: { amountCents: 500, credits: 100, reference: "code:crd_1:sub-1" },
    });
    expect(parseGrantRequest({ amount_usd: 5 })).toMatchObject({ ok: false });
    expect(parseGrantRequest({ amount_usd: 5, reference: "has space" })).toMatchObject({ ok: false });
  });

  it("refuses nothing-grants and anything over the cap", () => {
    expect(parseGrantRequest({ amount_usd: 0.01, reference: "r" })).toMatchObject({ ok: false });
    expect(parseGrantRequest({ amount_usd: (MAX_GRANT_CENTS + 1) / 100, reference: "r" })).toMatchObject({ ok: false });
    expect(parseGrantRequest({ amount_usd: "lots", reference: "r" })).toMatchObject({ ok: false });
    expect(parseGrantRequest({ amount_usd: MAX_GRANT_CENTS / 100, reference: "r" })).toMatchObject({ ok: true });
  });
});
