/**
 * CoinPay's business report reads /api/tracker/v1/report with a read-only
 * token. Pinned here: a stats:read token works on the tracker read routes and
 * nowhere else, and the report only ever contains the token owner's sites.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const db = vi.hoisted(() => ({
  token: null as null | { id: string; user_id: string; revoked_at: string | null; scope: string | null },
  projectsQueried: [] as string[],
}));

vi.mock("@/lib/sp/apiToken", () => ({
  isApiTokenShape: (t: string) => t.startsWith("crp_"),
  hashApiToken: (t: string) => `h:${t}`,
}));

const PROJECTS: Record<string, { id: string; name: string; url: string; owner_id: string }[]> = {
  "owner-a": [{ id: "pa1", name: "a.example", url: "https://a.example/", owner_id: "owner-a" }],
  "owner-b": [{ id: "pb1", name: "b.example", url: "https://b.example/", owner_id: "owner-b" }],
};

vi.mock("@/lib/supabase/service", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const b: Record<string, unknown> = {
        select: () => b,
        update: () => ({ eq: () => ({ then: (f: () => void) => f() }) }),
        eq: (col: string, v: unknown) => {
          filters[col] = v;
          return b;
        },
        maybeSingle: async () => ({ data: table === "sp_api_token" ? db.token : null, error: null }),
        is: async () => {
          db.projectsQueried.push(String(filters.owner_id));
          return { data: PROJECTS[String(filters.owner_id)] ?? [], error: null };
        },
      };
      return b;
    },
  }),
}));

vi.mock("@/lib/tracker/apiStats", async (orig) => {
  const real = await orig<typeof import("@/lib/tracker/apiStats")>();
  return {
    ...real,
    projectStats: vi.fn(async (_sb: unknown, p: { id: string; name: string; url: string }) => ({
      project: p,
      range: "1w",
      who: "humans",
      totals: { visitors: 10, pageviews: 30, events: 40 },
      sources: [{ label: "google", value: 7 }],
      referrers: [],
      pages: Array.from({ length: 8 }, (_, i) => ({ label: `/p${i}`, value: 8 - i })),
      countries: [],
      cities: [],
      series: [1, 1, 3, 3].map((h, i) => ({ date: `d${i}`, pageviews: h, humans: h, bots: 2, ai: 1 })),
      mix: { humans: 8, bots: 8, ai: 4, events: 20 },
    })),
  };
});

import { authenticateToken, STATS_READ } from "@/lib/sp/apiAuth";
import { GET as reportGET } from "@/app/api/tracker/v1/report/route";
import { parseReportRange, trendOf } from "@/lib/tracker/ownerReport";

const req = (q = "", token = "crp_x") =>
  new NextRequest(`https://crawlproof.com/api/tracker/v1/report${q}`, {
    headers: { authorization: `Bearer ${token}` },
  });

beforeEach(() => {
  db.token = { id: "t1", user_id: "owner-a", revoked_at: null, scope: STATS_READ };
  db.projectsQueried = [];
});

describe("token scopes", () => {
  it("refuses a read-only token on a route that did not opt in", async () => {
    const r = await authenticateToken("crp_x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });

  it("accepts a read-only token where the route allows stats:read", async () => {
    const r = await authenticateToken("crp_x", { allowScopes: [STATS_READ] });
    expect(r).toMatchObject({ ok: true, userId: "owner-a", scope: STATS_READ });
  });

  it("leaves a legacy full-access token working everywhere", async () => {
    db.token = { id: "t2", user_id: "owner-a", revoked_at: null, scope: null };
    expect((await authenticateToken("crp_x")).ok).toBe(true);
    expect((await authenticateToken("crp_x", { allowScopes: [STATS_READ] })).ok).toBe(true);
  });

  it("still refuses a revoked read-only token", async () => {
    db.token = { id: "t3", user_id: "owner-a", revoked_at: "2026-10-19T00:00:00Z", scope: STATS_READ };
    expect((await authenticateToken("crp_x", { allowScopes: [STATS_READ] })).ok).toBe(false);
  });
});

describe("GET /api/tracker/v1/report", () => {
  it("returns only the token owner's sites, whatever the query says", async () => {
    const r = await reportGET(req("?range=1w&owner=owner-b&site=pb1"));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.sites.map((s: { id: string }) => s.id)).toEqual(["pa1"]);
    expect(db.projectsQueried).toEqual(["owner-a"]);
  });

  it("gives owner B their own sites and never A's", async () => {
    db.token = { id: "t4", user_id: "owner-b", revoked_at: null, scope: STATS_READ };
    const body = await (await reportGET(req())).json();
    expect(body.sites.map((s: { id: string }) => s.id)).toEqual(["pb1"]);
    expect(JSON.stringify(body)).not.toContain("a.example");
  });

  it("summarises totals, top 5 pages and the trend", async () => {
    const body = await (await reportGET(req("?range=1m"))).json();
    expect(body.range).toBe("1m");
    expect(body.sites[0].top_pages).toHaveLength(5);
    expect(body.sites[0].hits).toEqual({ humans: 8, bots: 8, ai: 4 });
    expect(body.sites[0].trend).toEqual({ first_half: 2, second_half: 6, change_pct: 200 });
    expect(body.totals).toMatchObject({ visitors: 10, pageviews: 30, bots: 8 });
  });

  it("rejects an unknown range and a missing token", async () => {
    expect((await reportGET(req("?range=1h"))).status).toBe(400);
    const anon = await reportGET(new NextRequest("https://crawlproof.com/api/tracker/v1/report"));
    expect(anon.status).toBe(401);
  });
});

describe("helpers", () => {
  it("defaults the range to a week", () => {
    expect(parseReportRange(null)).toBe("1w");
    expect(parseReportRange("all")).toBeNull();
  });
  it("has no trend percentage when the first half is empty", () => {
    expect(trendOf([]).change_pct).toBeNull();
  });
});
