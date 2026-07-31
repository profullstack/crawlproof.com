import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SHORT_CODE_LENGTH,
  SHORT_CODE_RE,
  generateShortCode,
  isShortCode,
} from "@/lib/ads/shortcode";
import { renderCreativeText } from "@/lib/ads/terminal";
import type { AdCreative } from "@/lib/ads/formats";

// A paid terminal ad prints its click URL as literal text inside a box the
// caller sized. The UUID form was 61 characters (68 with a surface tag) against
// the 40 usable columns of a 44-col box, so it never fit. These pin the
// arithmetic that makes the short form fit, and the two compatibility rules
// that keep it from costing anyone money:
//
//   - click URLs already printed into MOTDs and SSH banners still resolve
//   - serving survives the deploy landing before the (hand-applied) migration

const PROD = "https://crawlproof.com";
const LEGACY_UUID = "2b1f0c94-8a1e-4c3d-9b77-1f0a2c3d4e5f";

function creative(over: Partial<AdCreative> = {}): AdCreative {
  return {
    format: "terminal_ascii",
    headline: "Ship faster with CrawlProof",
    body: "AI-readable audits for your site, in one command.",
    ctaText: "Try it free",
    bgColor: "#0b0d10",
    fgColor: "#e7e9ee",
    accentColor: "#6ee7b7",
    fontFamily: "system-ui",
    logoUrl: null,
    imageUrl: null,
    ...over,
  };
}

describe("generateShortCode", () => {
  it("produces base62 codes of the declared length", () => {
    for (let i = 0; i < 500; i++) {
      const code = generateShortCode();
      expect(code).toHaveLength(SHORT_CODE_LENGTH);
      expect(code).toMatch(SHORT_CODE_RE);
    }
  });

  it("does not repeat across a large sample", () => {
    const n = 20000;
    const seen = new Set(Array.from({ length: n }, () => generateShortCode()));
    expect(seen.size).toBe(n);
  });

  it("uses the whole alphabet roughly uniformly", () => {
    // Guards the rejection sampling: a plain `byte % 62` would over-represent
    // the first four symbols, quietly costing entropy the width budget is
    // already tight on.
    const freq = new Map<string, number>();
    const n = 20000;
    for (let i = 0; i < n; i++) {
      for (const ch of generateShortCode()) freq.set(ch, (freq.get(ch) ?? 0) + 1);
    }
    expect(freq.size).toBe(62);
    const expected = (n * SHORT_CODE_LENGTH) / 62;
    for (const count of freq.values()) {
      expect(Math.abs(count - expected) / expected).toBeLessThan(0.1);
    }
  });

  it("tells a short code apart from a UUID", () => {
    expect(isShortCode(generateShortCode())).toBe(true);
    expect(isShortCode(LEGACY_UUID)).toBe(false);
    expect(isShortCode("")).toBe(false);
    expect(isShortCode(null)).toBe(false);
    expect(isShortCode("../../etc/passwd")).toBe(false);
    expect(isShortCode(`${generateShortCode()}x`)).toBe(false);
  });
});

describe("paid click URL width", () => {
  it("fits inside the frame at every supported width", () => {
    for (const cols of [44, 52, 60, 72, 120]) {
      for (let i = 0; i < 50; i++) {
        const url = `${PROD}/a/${generateShortCode()}`;
        const text = renderCreativeText(creative(), url, { cols });
        for (const line of text.split("\n")) {
          expect(line).toHaveLength(cols);
          expect(line.startsWith("|") || line.startsWith("+")).toBe(true);
        }
        expect(text).toContain(url);
      }
    }
  });

  it("is short enough to leave headroom at the narrowest box", () => {
    const url = `${PROD}/a/${generateShortCode()}`;
    // cols 44 -> inner 40. Anything longer gets pushed outside the frame.
    expect(url.length).toBeLessThanOrEqual(40);
  });

  it("the old UUID form did not fit, which is why this exists", () => {
    expect(`${PROD}/a/${LEGACY_UUID}`.length).toBeGreaterThan(40);
  });
});

// --- click resolution ------------------------------------------------------

const db = vi.hoisted(() => ({ handler: vi.fn() }));

vi.mock("@/lib/supabase/service", () => ({
  serviceClient: () => ({
    from: (table: string) => db.handler(table),
  }),
}));

const resolveClick = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ads/serve", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveClick,
}));

vi.mock("@/lib/tracker/geo", () => ({
  clientIpFromHeaders: () => "203.0.113.9",
  lookupGeo: async () => ({ countryCode: "US" }),
}));

/**
 * Minimal ad_impressions stub.
 *
 * `hasSrcColumn: false` reproduces the pre-migration database: any projection
 * naming `src` comes back empty, exactly as PostgREST behaves on an unknown
 * column.
 */
function impressionsTable(row: Record<string, unknown> | null, hasSrcColumn = true) {
  return (_table: string) => {
    let wantsSrc = false;
    let matched = true;
    const chain: Record<string, unknown> = {
      select: (cols: string) => {
        wantsSrc = cols.includes("src");
        return chain;
      },
      eq: (column: string, value: unknown) => {
        // Only answer for the column the row is actually addressed by.
        if (row && row[column] !== value) matched = false;
        return chain;
      },
      maybeSingle: async () => {
        if (!row || !matched) return { data: null, error: null };
        if (wantsSrc && !hasSrcColumn) {
          return { data: null, error: { message: 'column "src" does not exist' } };
        }
        const { src, ...rest } = row as { src?: unknown };
        return { data: wantsSrc ? row : rest, error: null };
      },
    };
    return chain;
  };
}

const IMPRESSION = {
  id: LEGACY_UUID,
  short_code: "zCjQTqLAGEJJ",
  slot_id: "slot-1",
  campaign_id: "camp-1",
  creative_id: "cre-1",
  visitor_id: null,
  src: "bbs",
};

async function click(url: string, id: string) {
  const { GET } = await import("@/app/a/[id]/route");
  return GET(new Request(url) as never, { params: Promise.resolve({ id }) });
}

describe("/a/<id> click resolution", () => {
  beforeEach(() => {
    vi.resetModules();
    db.handler.mockReset();
    resolveClick.mockReset();
    resolveClick.mockResolvedValue("https://advertiser.example/landing");
  });

  it("resolves a short code and meters the click", async () => {
    db.handler.mockImplementation(impressionsTable(IMPRESSION));
    const res = await click(`${PROD}/a/zCjQTqLAGEJJ`, "zCjQTqLAGEJJ");
    expect(res.status).toBe(302);
    expect(resolveClick).toHaveBeenCalledOnce();
    expect(resolveClick.mock.calls[0][0]).toMatchObject({ campaignId: "camp-1" });
  });

  it("still resolves a legacy UUID, so already-printed banners keep working", async () => {
    db.handler.mockImplementation(impressionsTable(IMPRESSION));
    const res = await click(`${PROD}/a/${LEGACY_UUID}`, LEGACY_UUID);
    expect(res.status).toBe(302);
    expect(resolveClick).toHaveBeenCalledOnce();
  });

  it("rejects anything that is neither form without touching the database", async () => {
    db.handler.mockImplementation(impressionsTable(IMPRESSION));
    for (const bad of ["../../etc/passwd", "'; drop table ad_impressions;--", "x"]) {
      const res = await click(`${PROD}/a/${bad}`, bad);
      expect(res.status).toBe(302);
      // Bounced to the site root (env.siteUrl, which is localhost under test),
      // never to a click-metering destination.
      const loc = res.headers.get("location") ?? "";
      expect(new URL(loc).pathname).toBe("/");
    }
    expect(resolveClick).not.toHaveBeenCalled();
  });

  it("takes the surface tag from the impression row", async () => {
    db.handler.mockImplementation(impressionsTable(IMPRESSION));
    const res = await click(`${PROD}/a/zCjQTqLAGEJJ`, "zCjQTqLAGEJJ");
    const loc = new URL(res.headers.get("location") ?? "");
    expect(loc.searchParams.get("utm_content")).toBe("bbs");
  });

  it("falls back to the query string for URLs that still carry ?s=", async () => {
    db.handler.mockImplementation(impressionsTable({ ...IMPRESSION, src: null }));
    const res = await click(`${PROD}/a/${LEGACY_UUID}?s=ssh-banner`, LEGACY_UUID);
    const loc = new URL(res.headers.get("location") ?? "");
    expect(loc.searchParams.get("utm_content")).toBe("ssh-banner");
  });

  it("still resolves a legacy UUID when the src column does not exist yet", async () => {
    // Deploy ahead of the hand-applied migration: the projection naming `src`
    // fails, and the click must fall back rather than be dropped.
    db.handler.mockImplementation(impressionsTable(IMPRESSION, false));
    const res = await click(`${PROD}/a/${LEGACY_UUID}`, LEGACY_UUID);
    expect(res.status).toBe(302);
    expect(resolveClick).toHaveBeenCalledOnce();
  });
});
