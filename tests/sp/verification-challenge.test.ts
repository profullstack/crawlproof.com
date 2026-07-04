import { describe, it, expect } from "vitest";
import { makeCodeWaiter } from "@/lib/sp/verificationChallenge";

// In-memory stand-in for the single sp_post row the waiter reads/writes.
function fakeSb(initial: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = { id: "post-1", status: "publishing", ...initial };
  const updates: Record<string, unknown>[] = [];
  const sb = {
    from() {
      return {
        update(payload: Record<string, unknown>) {
          updates.push(payload);
          Object.assign(row, payload);
          return { eq() { return Promise.resolve({ data: null, error: null }); } };
        },
        select() {
          return {
            eq() {
              return {
                maybeSingle: async () => ({
                  data: { verification_code: row.verification_code ?? null },
                  error: null,
                }),
              };
            },
          };
        },
      };
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { sb: sb as any, row, updates };
}

describe("makeCodeWaiter", () => {
  it("marks the post awaiting_code, returns the submitted code, and clears it", async () => {
    const { sb, row, updates } = fakeSb();
    const waiter = makeCodeWaiter(sb, "post-1", { timeoutMs: 2000, pollMs: 20 });

    const p = waiter("LinkedIn needs a code");
    // Simulate the user submitting a code shortly after the prompt appears.
    setTimeout(() => {
      row.verification_code = "437748";
    }, 50);

    await expect(p).resolves.toBe("437748");

    // First update flips to awaiting_code with the prompt.
    expect(updates[0]).toMatchObject({
      status: "awaiting_code",
      verification_prompt: "LinkedIn needs a code",
      verification_code: null,
    });
    // Final state: back to publishing, code consumed so it can't replay.
    expect(row.status).toBe("publishing");
    expect(row.verification_code).toBeNull();
    expect(row.verification_prompt).toBeNull();
  });

  it("throws on timeout when no code is submitted", async () => {
    const { sb } = fakeSb();
    const waiter = makeCodeWaiter(sb, "post-1", { timeoutMs: 60, pollMs: 20 });
    await expect(waiter("prompt")).rejects.toThrow(/timed out/i);
  });

  it("trims whitespace around a submitted code", async () => {
    const { sb, row } = fakeSb();
    const waiter = makeCodeWaiter(sb, "post-1", { timeoutMs: 2000, pollMs: 20 });
    const p = waiter("prompt");
    setTimeout(() => {
      row.verification_code = "  123456  ";
    }, 40);
    await expect(p).resolves.toBe("123456");
  });
});
