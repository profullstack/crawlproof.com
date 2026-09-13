import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ error: false, throws: false, duplicate: false, filter: "", impression: { campaign_id: "campaign", slot_id: "slot" } }));
vi.mock("@/lib/supabase/service", () => ({ serviceClient: () => ({
  from() {
    if (state.throws) throw new Error("database unavailable");
    const q = {
      select: () => q, eq: () => q, gte: () => q, limit: () => q,
      maybeSingle: async () => ({ data: state.impression, error: state.error ? {} : null }),
      or: async (filter: string) => {
        state.filter = filter;
        return { data: state.duplicate ? [{ id: "previous" }] : [], error: state.error ? {} : null };
      },
    };
    return q;
  },
}) }));
import { assessClickValidity } from "@/lib/ads/fraud";
beforeEach(() => {
  state.error = false; state.throws = false; state.duplicate = false; state.filter = "";
  state.impression = { campaign_id: "campaign", slot_id: "slot" };
});
const input = { campaignId: "campaign", slotId: "slot", visitorId: "visitor", ipHashes: ["abc123"] };
describe("click validation", () => {
  it("deduplicates both paid and free delivery while excluding invalid traffic", async () => {
    state.duplicate = true;
    expect(await assessClickValidity(input)).toEqual({ valid: false, reason: "duplicate" });
    expect(state.filter).toBe("and(or(valid.eq.true,tier.eq.free),or(visitor_id.eq.visitor,ip_hash.eq.abc123))");
  });
  it("withholds billing if a database lookup fails or throws", async () => {
    state.error = true;
    expect((await assessClickValidity(input)).reason).toBe("validation_unavailable");
    expect((await assessClickValidity({ ...input, impressionId: "impression" })).reason).toBe("validation_unavailable");
    state.throws = true;
    expect((await assessClickValidity(input)).reason).toBe("validation_unavailable");
  });
  it("rejects bots, mismatched impressions and missing identities", async () => {
    expect((await assessClickValidity({ ...input, device: "bot" })).reason).toBe("bot");
    state.impression.campaign_id = "forged";
    expect((await assessClickValidity({ ...input, impressionId: "impression" })).reason).toBe("impression_mismatch");
    expect((await assessClickValidity({ campaignId: "campaign", visitorId: "v),injected" })).reason).toBe("missing_identity");
  });
  it("admits a new recognized visitor after successful validation", async () => {
    expect(await assessClickValidity(input)).toEqual({ valid: true });
  });
});
