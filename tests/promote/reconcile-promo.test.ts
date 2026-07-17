import { describe, it, expect } from "vitest";
import { reconcilePromo } from "@/lib/promote/reconcilePromo";

// Minimal chainable Supabase stub: select→eq→maybeSingle resolves `promo`;
// update(payload)→eq resolves; rpc records the call.
function makeSupabase(promo: unknown) {
  const updates: Record<string, unknown>[] = [];
  const rpcs: { name: string; args: unknown }[] = [];
  const client = {
    from() {
      return {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        maybeSingle() {
          return Promise.resolve({ data: promo, error: null });
        },
        update(payload: Record<string, unknown>) {
          updates.push(payload);
          return { eq: () => Promise.resolve({ error: null }) };
        },
      };
    },
    rpc(name: string, args: unknown) {
      rpcs.push({ name, args });
      return Promise.resolve({ error: null });
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any, updates, rpcs };
}

describe("reconcilePromo", () => {
  it("posted → fills the real URL + marks posted, no refund", async () => {
    const { client, updates, rpcs } = makeSupabase({
      id: "p1",
      status: "pending",
      credits_spent: 1,
      promo_list: { user_id: "u1" },
    });

    await reconcilePromo(client, "sp1", "posted", {
      postUrl: "https://reddit.com/r/x/comments/abc",
      platformPostId: "t3_abc",
    });

    expect(rpcs).toHaveLength(0);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      status: "posted",
      post_url: "https://reddit.com/r/x/comments/abc",
      external_post_id: "t3_abc",
      error: null,
    });
  });

  it("failed → refunds the credit and marks failed", async () => {
    const { client, updates, rpcs } = makeSupabase({
      id: "p1",
      status: "pending",
      credits_spent: 1,
      promo_list: { user_id: "u1" },
    });

    await reconcilePromo(client, "sp1", "failed", { error: "Login wall: session expired" });

    expect(rpcs).toEqual([{ name: "consume_credit", args: { p_owner: "u1", p_count: -1 } }]);
    expect(updates[0]).toMatchObject({ status: "failed", credits_spent: 0, error: "Login wall: session expired" });
  });

  it("is a no-op when the row is no longer pending (idempotent)", async () => {
    const { client, updates, rpcs } = makeSupabase({
      id: "p1",
      status: "posted",
      credits_spent: 1,
      promo_list: { user_id: "u1" },
    });

    await reconcilePromo(client, "sp1", "failed", { error: "late failure" });

    expect(updates).toHaveLength(0);
    expect(rpcs).toHaveLength(0);
  });

  it("is a no-op for an sp_post with no linked promo_post", async () => {
    const { client, updates, rpcs } = makeSupabase(null);

    await reconcilePromo(client, "sp-not-promo", "posted", { postUrl: "https://x" });

    expect(updates).toHaveLength(0);
    expect(rpcs).toHaveLength(0);
  });
});
