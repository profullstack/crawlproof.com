/**
 * `crawlproof stats` reads a project the caller owns.
 *
 * The two things worth pinning are the ones that decide whether an answer is
 * the right answer: which project a name resolves to, and that the resolution
 * is always scoped by owner so a token cannot read somebody else's site by
 * guessing its id.
 */
import { describe, expect, it } from "vitest";

import { mixFromSeries, resolveProject, seriesPoints, totalsFromSeries } from "@/lib/tracker/apiStats";
import { parseDetail } from "@/app/api/tracker/v1/stats/route";

type Row = { id: string; name: string; url: string };

/** A stand-in for the one query resolveProject makes. */
function client(rows: Row[], captured: Record<string, unknown> = {}) {
  const builder = {
    select: () => builder,
    eq: (column: string, value: unknown) => {
      captured[column] = value;
      return builder;
    },
    is: () => Promise.resolve({ data: rows, error: null }),
  };
  return { from: () => builder, captured } as never;
}

const rows: Row[] = [
  { id: "11111111-1111-1111-1111-111111111111", name: "dev.profullstack.com", url: "https://dev.profullstack.com/~anthony/blog/" },
  { id: "22222222-2222-2222-2222-222222222222", name: "nichedb.dev", url: "https://nichedb.dev/" },
];

describe("resolveProject", () => {
  it("finds a project by id, bare hostname and name", async () => {
    for (const site of ["22222222-2222-2222-2222-222222222222", "nichedb.dev", "https://nichedb.dev/pricing", "NicheDB.dev"]) {
      const result = await resolveProject(client(rows), "user-1", site);
      expect(result.ok, site).toBe(true);
      if (result.ok) expect(result.project.name, site).toBe("nichedb.dev");
    }
  });

  it("matches a hostname that carries a path and a www prefix", async () => {
    const result = await resolveProject(client(rows), "user-1", "www.dev.profullstack.com");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.project.name).toBe("dev.profullstack.com");
  });

  // The whole point of scoping: the query is always filtered to the caller.
  it("always filters by owner_id", async () => {
    const captured: Record<string, unknown> = {};
    await resolveProject(client(rows, captured), "user-1", "nichedb.dev");
    expect(captured.owner_id).toBe("user-1");
  });

  it("asks which site when there are several and none was named", async () => {
    const result = await resolveProject(client(rows), "user-1", null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toMatch(/nichedb\.dev/);
    }
  });

  it("needs no name when the account has exactly one project", async () => {
    const result = await resolveProject(client([rows[0] as Row]), "user-1", null);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.project.name).toBe("dev.profullstack.com");
  });

  it("says so when the name matches nothing, and lists what does", async () => {
    const result = await resolveProject(client(rows), "user-1", "someone-elses-site.com");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
      expect(result.error).toMatch(/nichedb\.dev/);
    }
  });

  it("reports an account with no projects rather than pretending", async () => {
    const result = await resolveProject(client([]), "user-1", null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(404);
  });
});

describe("totalsFromSeries", () => {
  it("sums the points, counting humans when visitors is absent", () => {
    expect(
      totalsFromSeries({ points: [{ visitors: 3, pageviews: 9 }, { visitors: 1, pageviews: 2 }] } as never),
    ).toEqual({ visitors: 4, pageviews: 11 });
    expect(totalsFromSeries({ points: [{ humans: 2, pageviews: 5 }] } as never)).toEqual({ visitors: 2, pageviews: 5 });
  });

  it("is zero for a list payload or nothing at all, rather than NaN", () => {
    expect(totalsFromSeries(undefined)).toEqual({ visitors: 0, pageviews: 0 });
    expect(totalsFromSeries([] as never)).toEqual({ visitors: 0, pageviews: 0 });
    expect(totalsFromSeries({ points: [{ pageviews: "4" }] } as never)).toEqual({ visitors: 0, pageviews: 4 });
  });
});

describe("seriesPoints", () => {
  it("trims a series payload to what a client can plot", () => {
    expect(
      seriesPoints({
        points: [{ date: "2026-09-01", pageviews: "4", humans: 3, bots: 1, ai: 2, interactions: 9 }],
      } as never),
    ).toEqual([{ date: "2026-09-01", pageviews: 4, humans: 3, bots: 1, ai: 2 }]);
  });

  it("is empty for a list payload or nothing, rather than throwing", () => {
    expect(seriesPoints(undefined)).toEqual([]);
    expect(seriesPoints([] as never)).toEqual([]);
  });
});

describe("mixFromSeries", () => {
  it("sums both sides, which is the only honest place a human share comes from", () => {
    expect(
      mixFromSeries({
        points: [
          { humans: 3, bots: 7, ai: 1, events: 10 },
          { humans: 2, bots: 8, ai: 0, events: 10 },
        ],
      } as never),
    ).toEqual({ humans: 5, bots: 15, ai: 1, events: 20 });
  });

  it("is zeros for nothing at all, never NaN", () => {
    expect(mixFromSeries(undefined)).toEqual({ humans: 0, bots: 0, ai: 0, events: 0 });
  });
});

describe("parseDetail", () => {
  it("only an affirmative buys the extra query", () => {
    expect(parseDetail("1")).toBe(true);
    expect(parseDetail("true")).toBe(true);
    expect(parseDetail(null)).toBe(false);
    expect(parseDetail("0")).toBe(false);
    expect(parseDetail("; drop table")).toBe(false);
  });
});
