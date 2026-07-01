import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { reconcileOutreach } from "@/lib/sp/outreachReconcile";

type OutreachRow = {
  id: string;
  sender_id: string | null;
  credits_spent: number | null;
  status: string;
  error?: string | null;
};
type ProfileRow = { id: string; credits_balance: number | null };

// Minimal in-memory stand-in for the two tables reconcileOutreach touches.
// Records the update payloads so assertions can inspect what was written.
function fakeSupabase(opts: {
  outreach: OutreachRow | null;
  profile?: ProfileRow | null;
}) {
  const state = {
    outreach: opts.outreach ? { ...opts.outreach } : null,
    profile: opts.profile ? { ...opts.profile } : null,
    outreachUpdates: [] as Record<string, unknown>[],
    profileUpdates: [] as Record<string, unknown>[],
  };

  const from = (table: string) => {
    if (table === "recent_outreach_messages") {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: state.outreach }),
          }),
        }),
        update: (payload: Record<string, unknown>) => {
          state.outreachUpdates.push(payload);
          if (state.outreach) Object.assign(state.outreach, payload);
          return { eq: async () => ({ data: null }) };
        },
      };
    }
    if (table === "profiles") {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: state.profile }),
          }),
        }),
        update: (payload: Record<string, unknown>) => {
          state.profileUpdates.push(payload);
          if (state.profile) Object.assign(state.profile, payload);
          return { eq: async () => ({ data: null }) };
        },
      };
    }
    throw new Error(`unexpected table ${table}`);
  };

  return { client: { from } as unknown as SupabaseClient<any>, state };
}

describe("reconcileOutreach", () => {
  it("no-ops when the post has no linked outreach row", async () => {
    const { client, state } = fakeSupabase({ outreach: null });
    await reconcileOutreach(client, "post-1", "failed", "boom");
    expect(state.outreachUpdates).toEqual([]);
    expect(state.profileUpdates).toEqual([]);
  });

  it("refunds the up-front credit and marks the row failed on failure", async () => {
    const { client, state } = fakeSupabase({
      outreach: { id: "m1", sender_id: "u1", credits_spent: 1, status: "queued" },
      profile: { id: "u1", credits_balance: 4 },
    });
    await reconcileOutreach(client, "post-1", "failed", "cookie expired");
    // Credit refunded: 4 -> 5.
    expect(state.profileUpdates).toEqual([{ credits_balance: 5 }]);
    // Row flipped to failed, error captured, credits zeroed (idempotency).
    expect(state.outreachUpdates).toEqual([
      { status: "failed", error: "cookie expired", credits_spent: 0 },
    ]);
  });

  it("does not refund twice when credits were already zeroed", async () => {
    const { client, state } = fakeSupabase({
      outreach: { id: "m1", sender_id: "u1", credits_spent: 0, status: "failed" },
      profile: { id: "u1", credits_balance: 5 },
    });
    await reconcileOutreach(client, "post-1", "failed", "boom");
    expect(state.profileUpdates).toEqual([]); // no refund
  });

  it("promotes a queued row to sent on success without touching credits", async () => {
    const { client, state } = fakeSupabase({
      outreach: { id: "m1", sender_id: "u1", credits_spent: 1, status: "queued" },
      profile: { id: "u1", credits_balance: 4 },
    });
    await reconcileOutreach(client, "post-1", "sent", null);
    expect(state.outreachUpdates).toEqual([{ status: "sent", error: null }]);
    expect(state.profileUpdates).toEqual([]);
  });

  it("leaves an already-sent row alone on success", async () => {
    const { client, state } = fakeSupabase({
      outreach: { id: "m1", sender_id: "u1", credits_spent: 1, status: "sent" },
    });
    await reconcileOutreach(client, "post-1", "sent", null);
    expect(state.outreachUpdates).toEqual([]);
  });

  it("still flips the row failed even if the profile is missing", async () => {
    const { client, state } = fakeSupabase({
      outreach: { id: "m1", sender_id: "u1", credits_spent: 1, status: "queued" },
      profile: null,
    });
    await reconcileOutreach(client, "post-1", "failed", "boom");
    expect(state.profileUpdates).toEqual([]); // nothing to credit
    expect(state.outreachUpdates).toEqual([
      { status: "failed", error: "boom", credits_spent: 0 },
    ]);
  });
});
