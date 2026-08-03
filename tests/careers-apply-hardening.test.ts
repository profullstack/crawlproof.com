import { beforeEach, describe, expect, it, vi } from "vitest";

// /api/careers/apply is an unauthenticated POST on the open internet. These
// cover the two spam defences and the owner notification, plus the rule that
// neither may ever turn a good application into a failure for the applicant.

const state = vi.hoisted(() => ({
  recentFromIp: 0,
  job: { id: "job-1", status: "open", title: "HPC Engineer" } as
    | { id: string; status: string; title: string }
    | null,
  project: { careers_enabled: true, tracker_enabled: true } as
    | { careers_enabled: boolean; tracker_enabled: boolean }
    | null,
  upserts: [] as Record<string, unknown>[],
  upsertError: null as { message: string } | null,
  notified: [] as Record<string, unknown>[],
  notifyThrows: false,
}));

function jobApplications() {
  const op: { kind?: string; payload?: unknown } = {};
  const b: Record<string, unknown> = {
    select: () => b,
    eq: () => b,
    gte: async () => ({ count: state.recentFromIp, error: null }),
    upsert: async (payload: Record<string, unknown>) => {
      state.upserts.push(payload);
      return { error: state.upsertError };
    },
    then: (res: (v: unknown) => unknown) => Promise.resolve({ count: state.recentFromIp }).then(res),
  };
  void op;
  return b;
}

vi.mock("@/lib/supabase/service", () => ({
  serviceClient: () => ({
    from(table: string) {
      if (table === "job_applications") return jobApplications();
      if (table === "job_postings") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({ maybeSingle: async () => ({ data: state.job, error: null }) }),
            }),
          }),
        };
      }
      if (table === "projects") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: state.project, error: null }) }),
          }),
        };
      }
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) };
    },
  }),
}));

vi.mock("@/lib/careers/notify", () => ({
  notifyNewApplication: async (n: Record<string, unknown>) => {
    if (state.notifyThrows) throw new Error("resend exploded");
    state.notified.push(n);
  },
}));

vi.mock("@/lib/tracker/geo", () => ({ clientIpFromHeaders: () => "203.0.113.9" }));

async function post(body: unknown) {
  const { POST } = await import("@/app/api/careers/apply/route");
  const req = new Request("https://crawlproof.com/api/careers/apply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  // The route reads request.nextUrl only on GET; a plain Request is enough here.
  const res = await POST(req as never);
  return { status: res.status, json: await res.json() };
}

const GOOD = {
  site: "11111111-1111-1111-1111-111111111111",
  job: "22222222-2222-2222-2222-222222222222",
  fullName: "Jane Doe",
  email: "Jane@Example.com",
  link: "github.com/jane",
};

beforeEach(() => {
  vi.resetModules();
  state.recentFromIp = 0;
  state.job = { id: "job-1", status: "open", title: "HPC Engineer" };
  state.project = { careers_enabled: true, tracker_enabled: true };
  state.upserts = [];
  state.upsertError = null;
  state.notified = [];
  state.notifyThrows = false;
});

describe("happy path", () => {
  it("accepts an application and normalizes what it stores", async () => {
    const res = await post(GOOD);
    expect(res.json.ok).toBe(true);
    expect(state.upserts).toHaveLength(1);
    expect(state.upserts[0]).toMatchObject({
      full_name: "Jane Doe",
      email: "jane@example.com",
      link: "https://github.com/jane",
    });
  });

  it("stamps a hashed source, never the raw address", async () => {
    await post(GOOD);
    const stored = state.upserts[0].ip_hash as string;
    expect(stored).toBeTruthy();
    expect(stored).not.toContain("203.0.113.9");
  });

  it("notifies the owner", async () => {
    await post(GOOD);
    expect(state.notified).toHaveLength(1);
    expect(state.notified[0]).toMatchObject({ jobTitle: "HPC Engineer", fullName: "Jane Doe" });
  });
});

describe("honeypot", () => {
  it("drops the submission without writing", async () => {
    const res = await post({ ...GOOD, company: "Acme Corp" });
    expect(state.upserts).toEqual([]);
    expect(state.notified).toEqual([]);
    // Answers exactly like success so whatever filled it gets no signal.
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
  });

  it("ignores an empty or whitespace honeypot, which is what browsers send", async () => {
    await post({ ...GOOD, company: "" });
    expect(state.upserts).toHaveLength(1);
    state.upserts = [];
    await post({ ...GOOD, company: "   " });
    expect(state.upserts).toHaveLength(1);
  });
});

describe("per-source rate limit", () => {
  it("rejects once the hourly cap is reached", async () => {
    const { APPLY_HOURLY_CAP } = await import("@/app/api/careers/apply/route");
    state.recentFromIp = APPLY_HOURLY_CAP;
    const res = await post(GOOD);
    expect(res.status).toBe(429);
    expect(state.upserts).toEqual([]);
  });

  it("still allows the application one below the cap", async () => {
    const { APPLY_HOURLY_CAP } = await import("@/app/api/careers/apply/route");
    state.recentFromIp = APPLY_HOURLY_CAP - 1;
    const res = await post(GOOD);
    expect(res.json.ok).toBe(true);
    expect(state.upserts).toHaveLength(1);
  });
});

describe("closed and disabled roles", () => {
  it("refuses a closed posting", async () => {
    state.job = { id: "job-1", status: "closed", title: "HPC Engineer" };
    const res = await post(GOOD);
    expect(res.status).toBe(410);
    expect(state.upserts).toEqual([]);
  });

  it("refuses when the project switched the module off", async () => {
    state.project = { careers_enabled: false, tracker_enabled: true };
    const res = await post(GOOD);
    expect(res.status).toBe(410);
  });
});

describe("validation", () => {
  it("rejects a bad email before writing", async () => {
    const res = await post({ ...GOOD, email: "not-an-email" });
    expect(res.json.ok).toBe(false);
    expect(state.upserts).toEqual([]);
  });

  // The dashboard renders the link as an href, so a script URL must not land.
  it("rejects a javascript: link", async () => {
    const res = await post({ ...GOOD, link: "javascript:alert(1)" });
    expect(res.json.ok).toBe(false);
    expect(state.upserts).toEqual([]);
  });
});

describe("failure isolation", () => {
  it("reports a write failure to the applicant", async () => {
    state.upsertError = { message: "boom" };
    const res = await post(GOOD);
    expect(res.status).toBe(500);
    expect(state.notified).toEqual([]);
  });
});
