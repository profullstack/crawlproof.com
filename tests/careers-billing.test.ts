import { beforeEach, describe, expect, it, vi } from "vitest";
import { JOB_POSTING_CREDITS } from "@/lib/credits";

// Publishing a job posting spends a credit. These pin the money rules:
// charged once per posting, never for drafts, never twice for the same role,
// and always refunded if the write that was supposed to publish it fails.

const state = vi.hoisted(() => ({
  project: { owner_id: "owner-1" } as { owner_id: string } | null,
  existingJob: null as { published_at: string | null; credit_charged_at: string | null } | null,
  siblings: [] as { slug: string }[],
  updateError: null as { message: string } | null,
  insertError: null as { message: string } | null,
  updates: [] as Record<string, unknown>[],
  inserts: [] as Record<string, unknown>[],
  consumeOk: true,
  consumed: [] as { owner: string; count: number }[],
  refunded: [] as { owner: string; count: number }[],
  usageEvents: [] as Record<string, unknown>[],
}));

function resolveOp(op: { kind?: string; payload?: unknown; cols?: string }) {
  if (op.kind === "update") {
    state.updates.push(op.payload as Record<string, unknown>);
    return { data: null, error: state.updateError };
  }
  if (op.kind === "insert") {
    state.inserts.push(op.payload as Record<string, unknown>);
    if (state.insertError) return { data: null, error: state.insertError };
    return { data: { id: "job-new" }, error: null };
  }
  if (op.cols?.includes("credit_charged_at")) return { data: state.existingJob, error: null };
  if (op.cols === "slug") return { data: state.siblings, error: null };
  return { data: null, error: null };
}

/** Chainable PostgREST-ish builder; terminal via await, .single(), .maybeSingle(). */
function builder() {
  const op: { kind?: string; payload?: unknown; cols?: string } = {};
  const b: Record<string, unknown> = {
    select(cols?: string) {
      op.cols = cols;
      op.kind ??= "select";
      return b;
    },
    update(row: unknown) {
      op.kind = "update";
      op.payload = row;
      return b;
    },
    insert(row: unknown) {
      op.kind = "insert";
      op.payload = row;
      return b;
    },
    delete() {
      op.kind = "delete";
      return b;
    },
    eq: () => b,
    order: () => b,
    limit: () => b,
    maybeSingle: async () => resolveOp(op),
    single: async () => resolveOp(op),
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(resolveOp(op)).then(res, rej),
  };
  return b;
}

const fakeSupabase = {
  from(table: string) {
    if (table === "projects") {
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: state.project, error: null }) }),
        }),
      };
    }
    return builder();
  },
};

vi.mock("@/lib/lx/currentSite", () => ({
  requireProjectAccess: async () => ({
    ok: true,
    userId: "user-1",
    userEmail: "u@example.com",
    isOwner: true,
    isViewer: false,
    supabase: fakeSupabase,
  }),
}));

vi.mock("@/lib/rateLimit", () => ({
  consumeCredit: async (owner: string, count: number) => {
    if (!state.consumeOk) return { ok: false };
    state.consumed.push({ owner, count });
    return { ok: true, remaining: 99 };
  },
  refundCredit: async (owner: string, count: number) => {
    state.refunded.push({ owner, count });
  },
}));

vi.mock("@/lib/supabase/service", () => ({
  serviceClient: () => ({
    from: () => ({
      insert: async (payload: Record<string, unknown>) => {
        state.usageEvents.push(payload);
        return { error: null };
      },
    }),
  }),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fakeSupabase }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

async function actions() {
  return await import("@/app/actions/careers");
}

const BASE = { projectId: "proj-1", title: "HPC Engineer" };

beforeEach(() => {
  vi.resetModules();
  state.project = { owner_id: "owner-1" };
  state.existingJob = null;
  state.siblings = [];
  state.updateError = null;
  state.insertError = null;
  state.updates = [];
  state.inserts = [];
  state.consumeOk = true;
  state.consumed = [];
  state.refunded = [];
  state.usageEvents = [];
});

describe("publishing a job posting charges a credit", () => {
  it("charges the project owner when a new role is created open", async () => {
    const { saveJobPosting } = await actions();
    const res = await saveJobPosting({ ...BASE, status: "open" });
    expect(res.ok).toBe(true);
    expect(state.consumed).toEqual([{ owner: "owner-1", count: JOB_POSTING_CREDITS }]);
    expect(state.inserts[0].credit_charged_at).toBeTruthy();
  });

  // The person clicking Publish may be a teammate; the project owner is the
  // billing entity, so it must not come out of the clicker's balance.
  it("bills the owner, not the acting user", async () => {
    const { saveJobPosting } = await actions();
    await saveJobPosting({ ...BASE, status: "open" });
    expect(state.consumed[0].owner).toBe("owner-1");
    expect(state.consumed[0].owner).not.toBe("user-1");
  });

  it("does not charge for a draft", async () => {
    const { saveJobPosting } = await actions();
    const res = await saveJobPosting({ ...BASE, status: "draft" });
    expect(res.ok).toBe(true);
    expect(state.consumed).toEqual([]);
    expect(state.inserts[0].credit_charged_at).toBeUndefined();
  });

  it("does not charge again when an already-paid role is edited while open", async () => {
    state.existingJob = { published_at: "2026-08-01T00:00:00Z", credit_charged_at: "2026-08-01T00:00:00Z" };
    const { saveJobPosting } = await actions();
    const res = await saveJobPosting({ ...BASE, jobId: "job-1", status: "open" });
    expect(res.ok).toBe(true);
    expect(state.consumed).toEqual([]);
  });

  it("charges an existing draft the first time it is published", async () => {
    state.existingJob = { published_at: null, credit_charged_at: null };
    const { saveJobPosting } = await actions();
    await saveJobPosting({ ...BASE, jobId: "job-1", status: "open" });
    expect(state.consumed).toHaveLength(1);
  });

  it("records a usage event so the spend is explainable", async () => {
    const { saveJobPosting } = await actions();
    await saveJobPosting({ ...BASE, status: "open" });
    expect(state.usageEvents).toHaveLength(1);
    expect(state.usageEvents[0]).toMatchObject({
      owner_id: "owner-1",
      kind: "job_posting_published",
    });
  });
});

describe("setJobStatus billing", () => {
  it("charges when a draft is published from the list", async () => {
    state.existingJob = { published_at: null, credit_charged_at: null };
    const { setJobStatus } = await actions();
    const res = await setJobStatus({ projectId: "proj-1", jobId: "job-1", status: "open" });
    expect(res.ok).toBe(true);
    expect(state.consumed).toHaveLength(1);
  });

  // You buy the posting, not the month it happens to be live.
  it("re-opening a closed role that already paid is free", async () => {
    state.existingJob = { published_at: "2026-07-01T00:00:00Z", credit_charged_at: "2026-07-01T00:00:00Z" };
    const { setJobStatus } = await actions();
    const res = await setJobStatus({ projectId: "proj-1", jobId: "job-1", status: "open" });
    expect(res.ok).toBe(true);
    expect(state.consumed).toEqual([]);
  });

  it("closing a role costs nothing", async () => {
    const { setJobStatus } = await actions();
    await setJobStatus({ projectId: "proj-1", jobId: "job-1", status: "closed" });
    expect(state.consumed).toEqual([]);
  });
});

describe("when the charge cannot be taken", () => {
  it("refuses to publish and says why", async () => {
    state.consumeOk = false;
    const { saveJobPosting } = await actions();
    const res = await saveJobPosting({ ...BASE, status: "open" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/credit/i);
    // Nothing was written, so the role is not silently live.
    expect(state.inserts).toEqual([]);
    expect(state.updates).toEqual([]);
  });

  it("refuses when the project has no owner to bill", async () => {
    state.project = null;
    const { saveJobPosting } = await actions();
    const res = await saveJobPosting({ ...BASE, status: "open" });
    expect(res.ok).toBe(false);
    expect(state.consumed).toEqual([]);
  });
});

describe("refunds", () => {
  // Spend-then-write means a failed write would otherwise leave the customer
  // charged for a posting that does not exist.
  it("refunds when the insert fails after charging", async () => {
    state.insertError = { message: "boom" };
    const { saveJobPosting } = await actions();
    const res = await saveJobPosting({ ...BASE, status: "open" });
    expect(res.ok).toBe(false);
    expect(state.consumed).toHaveLength(1);
    expect(state.refunded).toEqual([{ owner: "owner-1", count: JOB_POSTING_CREDITS }]);
  });

  it("refunds when the publish update fails", async () => {
    state.existingJob = { published_at: null, credit_charged_at: null };
    state.updateError = { message: "boom" };
    const { setJobStatus } = await actions();
    const res = await setJobStatus({ projectId: "proj-1", jobId: "job-1", status: "open" });
    expect(res.ok).toBe(false);
    expect(state.refunded).toEqual([{ owner: "owner-1", count: JOB_POSTING_CREDITS }]);
  });

  it("does not refund when nothing was charged", async () => {
    state.existingJob = { published_at: "2026-07-01T00:00:00Z", credit_charged_at: "2026-07-01T00:00:00Z" };
    state.updateError = { message: "boom" };
    const { setJobStatus } = await actions();
    await setJobStatus({ projectId: "proj-1", jobId: "job-1", status: "open" });
    expect(state.refunded).toEqual([]);
  });
});
