import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { apiBase, apiToken, coinpayAuth, parseArgs } from "@/packages/cli/src/cli";
import { renderStats } from "@/lib/dashboard/stats-text";

const args = (argv: string[]) => parseArgs(argv);

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("parseArgs", () => {
  it("reads --k=v, --k v and bare flags", () => {
    const a = args(["dashboard", "site.com", "--range=1w", "--who", "bots", "--json"]);
    expect(a.command).toBe("dashboard");
    expect(a.flags.range).toBe("1w");
    expect(a.flags.who).toBe("bots");
    expect(a.flags.json).toBe(true);
    expect(a.positional).toEqual(["site.com"]);
  });

  // Known sharp edge, shared with the in-repo CLI: a bare flag takes the next
  // bare word as its value, so a positional must not follow one. Pinned here
  // so it stays a decision rather than becoming a surprise.
  it("lets a bare flag swallow a following positional", () => {
    const a = args(["stats", "--json", "site.com"]);
    expect(a.flags.json).toBe("site.com");
    expect(a.positional).toEqual([]);
  });
});

describe("apiToken", () => {
  it("prefers the flag, then the environment", () => {
    process.env.CRAWLPROOF_TOKEN = "crp_env";
    expect(apiToken(args(["stats", "--token=crp_flag"]))).toBe("crp_flag");
    expect(apiToken(args(["stats"]))).toBe("crp_env");
  });

  it("falls back to the config file so no export is needed", () => {
    delete process.env.CRAWLPROOF_TOKEN;
    const dir = mkdtempSync(join(tmpdir(), "cp-"));
    const file = join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ token: "crp_file" }));
    process.env.CRAWLPROOF_CONFIG = file;
    expect(apiToken(args(["stats"]))).toBe("crp_file");
  });

  it("is null rather than empty when there is no token anywhere", () => {
    delete process.env.CRAWLPROOF_TOKEN;
    process.env.CRAWLPROOF_CONFIG = join(tmpdir(), "definitely-not-here.json");
    expect(apiToken(args(["stats"]))).toBeNull();
  });
});

describe("apiBase", () => {
  it("drops a trailing slash so paths do not double up", () => {
    expect(apiBase(args(["stats", "--base=https://x.dev/"]))).toBe("https://x.dev");
  });
});

describe("coinpayAuth", () => {
  it("appends /api when the configured base is a bare origin", () => {
    process.env.COINPAY_SESSION_TOKEN = "jwt";
    process.env.COINPAY_API_URL = "https://coinpayportal.com";
    expect(coinpayAuth(args(["dashboard"]))?.baseUrl).toBe("https://coinpayportal.com/api");
  });

  it("leaves a base that already ends in /api alone", () => {
    process.env.COINPAY_SESSION_TOKEN = "jwt";
    process.env.COINPAY_API_URL = "https://coinpayportal.com/api";
    expect(coinpayAuth(args(["dashboard"]))?.baseUrl).toBe("https://coinpayportal.com/api");
  });

  it("is null with no session, so the money panels can say so", () => {
    delete process.env.COINPAY_SESSION_TOKEN;
    process.env.COINPAY_CONFIG = join(tmpdir(), "no-coinpay-here.json");
    expect(coinpayAuth(args(["dashboard"]))).toBeNull();
  });
});

describe("renderStats", () => {
  it("prints totals and each populated section", () => {
    const text = renderStats(
      {
        project: { name: "site.com" },
        totals: { visitors: 10, pageviews: 4 },
        sources: [{ label: "Search · google", value: 9 }],
        pages: [{ label: "/", value: 4 }],
      },
      { range: "1d", who: "humans" },
    );
    expect(text).toContain("site.com  1d  humans");
    expect(text).toContain("10 visitors, 4 pageviews");
    expect(text).toContain("Search · google");
    expect(text).not.toContain("Referrers");
  });

  it("names the likely cause when there is nothing at all", () => {
    const text = renderStats({ totals: { visitors: 0, pageviews: 0 } }, { range: "1d", who: "humans" });
    expect(text).toContain("Check the tag is on the page");
  });
});
