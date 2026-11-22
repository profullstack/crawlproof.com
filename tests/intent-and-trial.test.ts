import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TRIAL_CREDITS, TRIAL_DAYS, spendableCredits, trialStatus } from "@/lib/trial";
import { leadTier, leadsToCsv, matchCompetitor, nextRunAt, parseTerms, signBody, type LeadRow } from "@/lib/intent/tiers";
import { IntentError, normaliseWatch } from "@/lib/intent/store";
import { runIntent } from "@/lib/intent/cli";

const now = new Date("2026-11-22T12:00:00Z");

describe("trial", () => {
  it("is a 30-day, card-free credit pool", () => {
    expect(TRIAL_DAYS).toBe(30);
    expect(TRIAL_CREDITS).toBeGreaterThan(0);
  });

  it("counts trial credits only while the trial is live", () => {
    const live = { credits_balance: 3, trial_credits: 300, trial_ends_at: "2026-12-10T00:00:00Z" };
    expect(trialStatus(live, now)).toMatchObject({ active: true, daysLeft: 18, creditsLeft: 300 });
    expect(spendableCredits(live, now)).toBe(303);
    const ended = { ...live, trial_ends_at: "2026-11-01T00:00:00Z" };
    expect(trialStatus(ended, now)).toMatchObject({ active: false, daysLeft: 0, creditsLeft: 0 });
    expect(spendableCredits(ended, now)).toBe(3);
  });

  it("treats a missing profile as zero", () => {
    expect(spendableCredits(null, now)).toBe(0);
    expect(trialStatus(undefined, now).active).toBe(false);
  });
});

describe("intent tiers", () => {
  it("buckets scores into hot / engage / monitor", () => {
    expect(leadTier(94)).toBe("hot");
    expect(leadTier(70)).toBe("hot");
    expect(leadTier(55)).toBe("engage");
    expect(leadTier(12)).toBe("monitor");
  });

  it("matches competitor names on word boundaries only", () => {
    expect(matchCompetitor("Anyone moved off Acme? pricing hurts", ["Acme"])).toBe("Acme");
    expect(matchCompetitor("acmeville is nice", ["Acme"])).toBeNull();
    expect(matchCompetitor("we use Node.js today", ["node.js"])).toBe("node.js");
  });

  it("parses term lists, trimming and de-duplicating", () => {
    expect(parseTerms("a, B ,b,\n c,,")).toEqual(["a", "B", "c"]);
    expect(parseTerms(["x", "x", " y "])).toEqual(["x", "y"]);
  });

  it("schedules by cadence", () => {
    expect(nextRunAt("4h", now).toISOString()).toBe("2026-11-22T16:00:00.000Z");
    expect(nextRunAt("daily", now).toISOString()).toBe("2026-11-23T12:00:00.000Z");
  });

  it("signs webhook bodies with HMAC-SHA256", () => {
    const body = '{"a":1}';
    expect(signBody("s3cret", body)).toBe(`sha256=${createHmac("sha256", "s3cret").update(body).digest("hex")}`);
  });

  it("exports CSV with quoting and formula injection defused", () => {
    const row: LeadRow = {
      source: "reddit",
      url: "https://reddit.com/r/x/1",
      title: '=HYPERLINK("evil")',
      snippet: 'needs a tool, "fast"',
      posted_at: null,
      score: 88,
      tier: "hot",
      intent_kind: "solicitation",
      competitor: null,
      status: "new",
    };
    const csv = leadsToCsv([row]);
    const line = csv.split("\n")[1];
    expect(line.startsWith("88,Hot lead,Reddit,")).toBe(true);
    expect(line).toContain(`"'=HYPERLINK(""evil"")"`);
    expect(line).toContain(`"needs a tool, ""fast"""`);
  });
});

describe("watch validation", () => {
  it("requires a name and something to track", () => {
    expect(() => normaliseWatch({ name: "", keywords: "x" })).toThrow(IntentError);
    expect(() => normaliseWatch({ name: "Acme" })).toThrow(/keyword or competitor/);
  });

  it("only accepts real Slack/Discord hooks and https webhooks", () => {
    expect(() => normaliseWatch({ name: "A", keywords: "x", slack_webhook_url: "https://evil.example/hook" })).toThrow(/hooks.slack.com/);
    expect(() => normaliseWatch({ name: "A", keywords: "x", webhook_url: "http://example.com" })).toThrow(/https/);
    const ok = normaliseWatch({
      name: "A",
      keywords: "x",
      discord_webhook_url: "https://discord.com/api/webhooks/1/abc",
      webhook_url: "https://hooks.zapier.com/1",
      sources: ["reddit", "bogus"],
      cadence: "4h",
      min_score: 250,
    });
    expect(ok).toMatchObject({ sources: ["reddit"], cadence: "4h", min_score: 100 });
  });

  it("keeps absent fields absent on partial updates", () => {
    expect(normaliseWatch({ active: false }, true)).toEqual({ active: false });
  });
});

describe("crawlproof intent CLI", () => {
  it("lists leads from the API", async () => {
    const lines: string[] = [];
    const calls: string[] = [];
    const code = await runIntent(
      ["leads"],
      { tier: "hot" },
      async (method, path) => {
        calls.push(`${method} ${path}`);
        return { status: 200, json: { leads: [{ id: "l1", score: 91, tier: "hot", source: "reddit", title: "Need a tool", url: "https://r/1", status: "new" }] } };
      },
      { write: (l) => lines.push(l), error: (l) => lines.push(`ERR ${l}`) },
    );
    expect(code).toBe(0);
    expect(calls).toEqual(["GET /api/intent/v1/leads?tier=hot"]);
    expect(lines.join("\n")).toContain("Need a tool");
  });

  it("reports API errors with exit 1 and bad usage with exit 2", async () => {
    const out = { write: () => undefined, error: () => undefined };
    expect(await runIntent(["run", "w1"], {}, async () => ({ status: 402, json: { error: "Out of credits" } }), out)).toBe(1);
    expect(await runIntent(["reply"], {}, async () => ({ status: 200, json: {} }), out)).toBe(2);
  });
});
