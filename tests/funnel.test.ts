import { describe, it, expect, vi, beforeEach } from "vitest";

// The funnel reads two tables; the arithmetic on top of them is what matters
// and is what these cover. A fake client keeps the maths under test without
// standing up a database.
const rows: Record<string, unknown[]> = { sends: [], prospects: [], campaigns: [] };
let sendCount = 0;

vi.mock("@/lib/supabase/service", () => ({
  serviceClient: () => ({
    from(table: string) {
      const chain = {
        select: (_cols: string, opts?: { head?: boolean }) =>
          opts?.head ? { ...chain, count: sendCount } : chain,
        eq: () => chain,
        in: () => chain,
        then: undefined,
      } as Record<string, unknown>;
      // Terminal await resolves to the rows for this table.
      const key =
        table === "outreach_sends" ? "sends" : table === "outreach_prospects" ? "prospects" : "campaigns";
      Object.assign(chain, {
        then: (resolve: (v: unknown) => void) =>
          resolve({ data: rows[key], count: table === "outreach_sends" ? sendCount : null }),
      });
      return chain;
    },
  }),
}));

const { projectFunnel } = await import("@/lib/outreach/funnel");

function prospects(spec: Record<string, number>) {
  const out: { status: string }[] = [];
  for (const [status, n] of Object.entries(spec)) {
    for (let i = 0; i < n; i++) out.push({ status });
  }
  return out;
}

beforeEach(() => {
  rows.sends = [];
  rows.prospects = [];
  rows.campaigns = [];
  sendCount = 0;
});

describe("projectFunnel", () => {
  it("withholds rates until the sample can carry one", async () => {
    sendCount = 3;
    rows.prospects = prospects({ contacted: 2, replied: 1 });
    const f = await projectFunnel("p1");
    // One reply in three sends is not a 33% reply rate.
    expect(f.replyRate).toBeNull();
    expect(f.closeRate).toBeNull();
    expect(f.rateNote).toMatch(/17 more sends/);
  });

  it("computes reply rate over people contacted, not sends", async () => {
    sendCount = 60; // follow-ups mean sends exceed people
    rows.prospects = prospects({ contacted: 36, replied: 4 });
    const f = await projectFunnel("p1");
    expect(f.contacted).toBe(40);
    // 4 replies / 40 people, not 4 / 60 sends.
    expect(f.replyRate).toBeCloseTo(0.1);
  });

  it("counts won and lost as having replied", async () => {
    sendCount = 40;
    rows.prospects = prospects({ contacted: 20, replied: 5, won: 3, lost: 2 });
    const f = await projectFunnel("p1");
    // A deal or a rejection both required a conversation first.
    expect(f.replied).toBe(10);
    expect(f.won).toBe(3);
    expect(f.lost).toBe(2);
  });

  it("computes close rate over replies, not over everyone contacted", async () => {
    sendCount = 40;
    rows.prospects = prospects({ contacted: 30, replied: 6, won: 4 });
    const f = await projectFunnel("p1");
    expect(f.replied).toBe(10);
    // 4 won / 10 replied — dividing by all 40 contacted would flatter nothing
    // and would answer a different question.
    expect(f.closeRate).toBeCloseTo(0.4);
  });

  it("says there is no close rate rather than showing zero", async () => {
    sendCount = 40;
    rows.prospects = prospects({ contacted: 40 });
    const f = await projectFunnel("p1");
    expect(f.replyRate).toBe(0);
    expect(f.closeRate).toBeNull();
    expect(f.rateNote).toMatch(/no replies yet/);
  });

  it("reports zeroes cleanly with no data at all", async () => {
    const f = await projectFunnel("p1");
    expect(f).toMatchObject({ sent: 0, contacted: 0, replied: 0, won: 0 });
    expect(f.replyRate).toBeNull();
  });
});
