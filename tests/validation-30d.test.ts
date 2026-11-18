import { describe, it, expect, vi } from "vitest";
import {
  GRACE_DAYS,
  MONITOR_PLANS,
  PERIOD_DAYS,
  RENEWAL_NOTICE_DAYS,
  isMonitorPlan,
  nextPeriodEnd,
  priceLabel,
  sweepAction,
} from "@/lib/monitoring";
import { reportIndexable, topFixes } from "@/lib/audit/top-fixes";
import { parseDomainsCsv, runBatch, runRanking, toResultsCsv } from "@/lib/batchCli";
import { domainToUrl, rankRows } from "@/lib/batch-audits";
import { parseSource, parseVisitorId, readCookieValue } from "@/lib/funnel-shared";
import { funnelContext } from "@/lib/funnel";
import type { Finding } from "@/lib/audit/types";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-11-18T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

describe("monitoring plans", () => {
  it("prices Solo at $49 for 1 site and Agency at $199 for 20", () => {
    expect(MONITOR_PLANS.solo).toMatchObject({ amountCents: 4900, siteLimit: 1 });
    expect(MONITOR_PLANS.agency).toMatchObject({ amountCents: 19900, siteLimit: 20 });
    expect(priceLabel(4900)).toBe("$49");
    expect(priceLabel(19900)).toBe("$199");
    expect(isMonitorPlan("agency")).toBe(true);
    expect(isMonitorPlan("enterprise")).toBe(false);
  });

  it("a first payment buys 30 days from now", () => {
    expect(nextPeriodEnd(null, now).getTime()).toBe(now.getTime() + PERIOD_DAYS * DAY);
  });

  it("paying early extends from the current end, never losing days", () => {
    const end = now.getTime() + 4 * DAY;
    expect(nextPeriodEnd(iso(end), now).getTime()).toBe(end + PERIOD_DAYS * DAY);
  });

  it("paying after a lapse starts from now", () => {
    expect(nextPeriodEnd(iso(now.getTime() - 10 * DAY), now).getTime()).toBe(now.getTime() + PERIOD_DAYS * DAY);
  });
});

describe("sweepAction", () => {
  const base = { status: "active" as const, cancel_at_period_end: false, renewal_notified_at: null };

  it("does nothing mid-period", () => {
    expect(sweepAction({ ...base, current_period_end: iso(now.getTime() + 20 * DAY) }, now)).toBe("none");
  });

  it("reminds once inside the notice window", () => {
    const end = now.getTime() + (RENEWAL_NOTICE_DAYS - 1) * DAY;
    expect(sweepAction({ ...base, current_period_end: iso(end) }, now)).toBe("remind");
    expect(
      sweepAction({ ...base, current_period_end: iso(end), renewal_notified_at: iso(now.getTime() - DAY) }, now),
    ).toBe("none");
  });

  it("a reminder from the previous period does not suppress this one", () => {
    const end = now.getTime() + 2 * DAY;
    const lastPeriodNotice = iso(end - (PERIOD_DAYS + 3) * DAY);
    expect(sweepAction({ ...base, current_period_end: iso(end), renewal_notified_at: lastPeriodNotice }, now)).toBe(
      "remind",
    );
  });

  it("keeps running through the grace days, then ends", () => {
    expect(sweepAction({ ...base, current_period_end: iso(now.getTime() - (GRACE_DAYS - 1) * DAY), renewal_notified_at: iso(now.getTime() - 5 * DAY) }, now)).toBe("none");
    expect(sweepAction({ ...base, current_period_end: iso(now.getTime() - (GRACE_DAYS + 1) * DAY) }, now)).toBe("end");
  });

  it("a cancelled subscription ends exactly at the period end and is never reminded", () => {
    const c = { ...base, cancel_at_period_end: true };
    expect(sweepAction({ ...c, current_period_end: iso(now.getTime() + 2 * DAY) }, now)).toBe("none");
    expect(sweepAction({ ...c, current_period_end: iso(now.getTime() - 1000) }, now)).toBe("end");
  });

  it("ignores anything not active", () => {
    expect(sweepAction({ ...base, status: "pending", current_period_end: null }, now)).toBe("none");
    expect(sweepAction({ ...base, status: "expired", current_period_end: iso(now.getTime() - 99 * DAY) }, now)).toBe("none");
  });
});

describe("report page", () => {
  const f = (check_key: string, status: Finding["status"], priority: Finding["priority"]): Finding => ({
    section: "s",
    check_key,
    status,
    title: check_key,
    priority,
  });

  it("leads with failures, then warnings, by priority, at most five", () => {
    const list = [
      f("w1", "warn", 1),
      f("f3", "fail", 3),
      f("ok", "pass", 1),
      f("f1", "fail", 1),
      f("rec.x", "fail", 1),
      f("todo.y", "fail", 1),
      f("w2", "warn", 2),
      f("f2", "fail", 2),
      f("w3", "warn", 3),
    ];
    expect(topFixes(list).map((x) => x.check_key)).toEqual(["f1", "f2", "f3", "w1", "w2"]);
  });

  it("keeps outreach and owned reports off search engines", () => {
    expect(reportIndexable({ owner_id: null, funnel_source: "organic" })).toBe(true);
    expect(reportIndexable({ owner_id: null, funnel_source: "ranking" })).toBe(true);
    expect(reportIndexable({ owner_id: null, funnel_source: "outreach" })).toBe(false);
    expect(reportIndexable({ owner_id: "u1", funnel_source: "organic" })).toBe(false);
    expect(reportIndexable({ owner_id: null })).toBe(true);
  });
});

describe("batch CSV", () => {
  it("reads the first column, skips the header, comments and duplicates", () => {
    const csv = 'domain,owner\n"acme.com",Jo\n# skip\nhttps://beta.io/,x\n\nacme.com,dup\nwebsite\n';
    expect(parseDomainsCsv(csv)).toEqual(["acme.com", "https://beta.io/"]);
  });

  it("writes domain,score,top_issue,report_url with quoting", () => {
    const csv = toResultsCsv([
      { domain: "acme.com", score: 62, top_issue: 'GPTBot blocked, "Disallow: /"', report_url: "https://x/r/a?src=outreach", status: "complete" },
      { domain: "slow.io", score: null, top_issue: "", report_url: "https://x/r/b?src=outreach", status: "running" },
    ]);
    expect(csv).toBe(
      'domain,score,top_issue,report_url\nacme.com,62,"GPTBot blocked, ""Disallow: /""",https://x/r/a?src=outreach\nslow.io,running,,https://x/r/b?src=outreach\n',
    );
  });

  it("turns bare domains into https URLs", () => {
    expect(domainToUrl(" acme.com ")).toBe("https://acme.com");
    expect(domainToUrl("http://acme.com")).toBe("http://acme.com");
  });

  it("ranks highest score first, unscored last", () => {
    const rows = rankRows([
      { domain: "b", score: 50 },
      { domain: "c", score: null },
      { domain: "a", score: 50 },
      { domain: "d", score: 90 },
    ]);
    expect(rows.map((r) => r.domain)).toEqual(["d", "a", "b", "c"]);
  });

  it("runBatch creates the batch, polls until done and writes the CSV", async () => {
    const calls: string[] = [];
    const api = vi.fn(async (method: "GET" | "POST", path: string, body?: Record<string, unknown>) => {
      calls.push(`${method} ${path}`);
      if (method === "POST") {
        expect(body).toMatchObject({ domains: ["acme.com", "beta.io"], source: "outreach" });
        return { status: 200, json: { batch_id: "b-1", created: [], rejected: [] } };
      }
      return {
        status: 200,
        json: {
          done: 2,
          total: 2,
          rows: [
            { domain: "acme.com", score: 70, top_issue: "No llms.txt", report_url: "u1", status: "complete" },
            { domain: "beta.io", score: 40, top_issue: "GPTBot blocked", report_url: "u2", status: "complete" },
          ],
        },
      };
    });
    const written: Record<string, string> = {};
    const code = await runBatch(
      ["in.csv"],
      { out: "out.csv" },
      api,
      { write: () => {}, error: () => {} },
      { read: () => "domain\nacme.com\nbeta.io\n", write: (p, s) => (written[p] = s) },
    );
    expect(code).toBe(0);
    expect(calls).toEqual(["POST /api/admin/batch-audits", "GET /api/admin/batch-audits?batch=b-1"]);
    expect(written["out.csv"]).toContain("acme.com,70,No llms.txt,u1");
  });

  it("runRanking refuses without the required flags", async () => {
    const api = vi.fn();
    const errors: string[] = [];
    const code = await runRanking(["publish"], { slug: "x" }, api, { write: () => {}, error: (l) => errors.push(l) });
    expect(code).toBe(2);
    expect(api).not.toHaveBeenCalled();
    expect(errors[0]).toContain("--title");
  });
});

describe("funnel parsing", () => {
  it("accepts only the three sources and our visitor ids", () => {
    expect(parseSource("outreach")).toBe("outreach");
    expect(parseSource("facebook")).toBeNull();
    expect(parseVisitorId("6f1c1b8e-0d6a-4a3a-9a59-1f2b3c4d5e6f")).toBe("6f1c1b8e-0d6a-4a3a-9a59-1f2b3c4d5e6f");
    expect(parseVisitorId("<script>")).toBeNull();
  });

  it("reads source and visitor from a Cookie header, defaulting to organic", () => {
    expect(readCookieValue("a=1; cp_src=ranking; b=2", "cp_src")).toBe("ranking");
    expect(funnelContext("cp_src=ranking; cp_vid=abcdef12-3456")).toEqual({ source: "ranking", visitorId: "abcdef12-3456" });
    expect(funnelContext("cp_src=evil")).toEqual({ source: "organic", visitorId: null });
    expect(funnelContext(null)).toEqual({ source: "organic", visitorId: null });
  });
});
