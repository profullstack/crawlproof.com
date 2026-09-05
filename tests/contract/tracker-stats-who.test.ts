import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

// The tracker-stats and live-events routes carry the page-wide Humans / Bots /
// All toggle. A missing `who` is the page default; a junk one is a 400, never
// a quiet fall-back to a different answer than the card asked for.

const rpc = vi.hoisted(() =>
  vi.fn(async () => ({ data: [], error: null })),
);

const liveQuery = vi.hoisted(() => {
  const calls: Array<[string, unknown[]]> = [];
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "gte", "like", "not", "order"]) {
    chain[m] = (...args: unknown[]) => {
      calls.push([m, args]);
      return chain;
    };
  }
  chain.limit = async () => ({ data: [], error: null });
  return { chain, calls };
});

vi.mock("@/lib/lx/currentSite", () => ({
  requireProjectAccess: async () => ({ ok: true }),
}));

vi.mock("@/lib/supabase/service", () => ({
  serviceClient: () => ({
    rpc,
    from: () => liveQuery.chain,
  }),
}));

import { GET as statsGET } from "@/app/api/projects/[id]/tracker-stats/route";
import { GET as liveGET } from "@/app/api/projects/[id]/live-events/route";

function req(url: string) {
  const request = new Request(url) as unknown as NextRequest;
  Object.defineProperty(request, "nextUrl", { value: new URL(url) });
  return request;
}

const params = Promise.resolve({ id: "p1" });

describe("GET /api/projects/:id/tracker-stats ?who=", () => {
  beforeEach(() => {
    rpc.mockClear();
  });

  it("defaults to humans and passes p_kind = human", async () => {
    const res = await statsGET(
      req("https://crawlproof.com/api/projects/p1/tracker-stats?range=1m&panel=pages"),
      { params },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).who).toBe("humans");
    expect(rpc).toHaveBeenCalledWith(
      "tracker_top_pages",
      expect.objectContaining({ p_kind: "human" }),
    );
  });

  it("maps bots and all onto p_kind", async () => {
    await statsGET(
      req("https://crawlproof.com/api/projects/p1/tracker-stats?range=1h&panel=pages&who=bots"),
      { params },
    );
    expect(rpc).toHaveBeenCalledWith(
      "tracker_recent_top_pages",
      expect.objectContaining({ p_kind: "bot" }),
    );

    rpc.mockClear();
    await statsGET(
      req("https://crawlproof.com/api/projects/p1/tracker-stats?range=1m&panel=devices&who=all"),
      { params },
    );
    expect(rpc).toHaveBeenCalledWith(
      "tracker_device_totals",
      expect.objectContaining({ p_kind: null }),
    );
  });

  it("rejects junk with a 400 instead of answering a different question", async () => {
    for (const bad of ["Humans", "human", "everyone", ""]) {
      const res = await statsGET(
        req(
          `https://crawlproof.com/api/projects/p1/tracker-stats?range=1m&panel=pages&who=${bad}`,
        ),
        { params },
      );
      expect(res.status, bad).toBe(400);
      expect((await res.json()).error).toMatch(/who/i);
    }
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("GET /api/projects/:id/live-events ?who=", () => {
  beforeEach(() => {
    liveQuery.calls.length = 0;
  });

  it("filters humans by excluding bot: buckets", async () => {
    const res = await liveGET(
      req("https://crawlproof.com/api/projects/p1/live-events?minutes=30"),
      { params },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).who).toBe("humans");
    expect(liveQuery.calls).toContainEqual(["not", ["bucket", "like", "bot:%"]]);
    expect(liveQuery.calls.find(([m]) => m === "like")).toBeUndefined();
  });

  it("filters bots by the bucket prefix and All by nothing", async () => {
    await liveGET(
      req("https://crawlproof.com/api/projects/p1/live-events?minutes=30&who=bots"),
      { params },
    );
    expect(liveQuery.calls).toContainEqual(["like", ["bucket", "bot:%"]]);

    liveQuery.calls.length = 0;
    await liveGET(
      req("https://crawlproof.com/api/projects/p1/live-events?minutes=30&who=all"),
      { params },
    );
    expect(liveQuery.calls.find(([m]) => m === "like" || m === "not")).toBeUndefined();
  });

  it("rejects junk with a 400", async () => {
    const res = await liveGET(
      req("https://crawlproof.com/api/projects/p1/live-events?minutes=30&who=robots"),
      { params },
    );
    expect(res.status).toBe(400);
    expect(liveQuery.calls).toHaveLength(0);
  });
});
