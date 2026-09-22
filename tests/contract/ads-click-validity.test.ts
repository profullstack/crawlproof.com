import { beforeEach, describe, expect, it, vi } from "vitest";

const HOUR = 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const fresh = () => ({ campaign_id: "campaign", slot_id: "slot", ts: ago(60_000), device: "desktop" as string | null });

const state = vi.hoisted(() => ({ error: false, throws: false, duplicate: false, filter: "", impression: { campaign_id: "campaign", slot_id: "slot", ts: "", device: "desktop" as string | null } }));
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
import { assessClickValidity, isStaleImpression, maxClickAgeMs } from "@/lib/ads/fraud";
beforeEach(() => {
  state.error = false; state.throws = false; state.duplicate = false; state.filter = "";
  state.impression = fresh();
});
const input = { campaignId: "campaign", slotId: "slot", visitorId: "visitor", ipHashes: ["abc123"] };
const cited = { ...input, impressionId: "impression" };
describe("click validation", () => {
  it("deduplicates both paid and free delivery while excluding invalid traffic", async () => {
    state.duplicate = true;
    expect(await assessClickValidity(input)).toEqual({ valid: false, reason: "duplicate" });
    expect(state.filter).toBe("and(or(valid.eq.true,tier.eq.free),or(visitor_id.eq.visitor,ip_hash.eq.abc123))");
  });
  it("withholds billing if a database lookup fails or throws", async () => {
    state.error = true;
    expect((await assessClickValidity(input)).reason).toBe("validation_unavailable");
    expect((await assessClickValidity(cited)).reason).toBe("validation_unavailable");
    state.throws = true;
    expect((await assessClickValidity(input)).reason).toBe("validation_unavailable");
  });
  it("rejects bots, mismatched impressions and missing identities", async () => {
    expect((await assessClickValidity({ ...input, device: "bot" })).reason).toBe("bot");
    state.impression.campaign_id = "forged";
    expect((await assessClickValidity(cited)).reason).toBe("impression_mismatch");
    expect((await assessClickValidity({ campaignId: "campaign", visitorId: "v),injected" })).reason).toBe("missing_identity");
  });
  it("admits a new recognized visitor after successful validation", async () => {
    expect(await assessClickValidity(input)).toEqual({ valid: true });
    expect(await assessClickValidity(cited)).toEqual({ valid: true });
  });
});

// The crawler shape: a feed document fetched with a browser user agent, its ad
// link requested two days later. Everything else about the click checks out,
// so the impression's age is the only thing that can refuse it.
describe("stale impressions", () => {
  it("refuses a click that trails a browser impression by more than the click window", async () => {
    state.impression = { ...fresh(), ts: ago(54 * HOUR) };
    expect(await assessClickValidity(cited)).toEqual({ valid: false, reason: "stale_impression" });
    state.impression = { ...fresh(), ts: ago(6 * HOUR + 1000), device: "mobile" };
    expect((await assessClickValidity(cited)).reason).toBe("stale_impression");
  });
  it("keeps a browser click inside the window, whatever the format", async () => {
    state.impression = { ...fresh(), ts: ago(3 * HOUR) };
    expect(await assessClickValidity(cited)).toEqual({ valid: true });
  });
  it("gives a terminal a day, because the MOTD is read at the next login", async () => {
    state.impression = { ...fresh(), ts: ago(12 * HOUR), device: "terminal" };
    expect(await assessClickValidity(cited)).toEqual({ valid: true });
    state.impression = { ...fresh(), ts: ago(2 * 24 * HOUR), device: "terminal" };
    expect((await assessClickValidity(cited)).reason).toBe("stale_impression");
  });
  it("never ages out a feed reader's click; unread items sit for days", async () => {
    state.impression = { ...fresh(), ts: ago(9 * 24 * HOUR), device: "feed" };
    expect(await assessClickValidity(cited)).toEqual({ valid: true });
  });
  it("treats an impression with no device or no timestamp conservatively", () => {
    expect(maxClickAgeMs(null)).toBe(6 * HOUR);
    expect(maxClickAgeMs("feed")).toBeNull();
    expect(isStaleImpression({ ts: null, device: "desktop" })).toBe(false);
    expect(isStaleImpression({ ts: "not a date", device: "desktop" })).toBe(false);
    expect(isStaleImpression({ ts: ago(7 * HOUR), device: null })).toBe(true);
  });
});
