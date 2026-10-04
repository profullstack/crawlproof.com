import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import {
  ACTOR_HEADER,
  DECLARED_AGENT_BUCKET,
  actorTokenFrom,
  applyDeclaration,
  browserLabel,
  clearActorCache,
  hashActorToken,
  isActorTokenShape,
  mintActorToken,
  normalizeEmail,
  resolveActor,
  toDeclaredTotals,
} from "@/lib/tracker/actors";
import { hashApiToken } from "@/lib/sp/apiToken";
import { rangeSinceDay } from "@/lib/tracker/actorStore";
import { trackerRange } from "@/lib/tracker/ranges";
import { renderStats } from "@/lib/dashboard/stats-text";
import { actorTokenHowTo, runActors } from "@/lib/tracker/actorsCli";
import { readFileSync } from "node:fs";

// Declared actors are on the honor system, and others will try to game it.
// These pin the parts that make lying cheap to spot and useless to profit
// from: a declaration only ever moves traffic toward the bot side, a bare
// email claims nothing, and names stay private to their owner.

const TOKEN = mintActorToken().plaintext;

describe("applyDeclaration (the asymmetric trust rule)", () => {
  it("believes an agent: a human-looking hit moves to bot:declared", () => {
    expect(applyDeclaration("human:direct", "agent")).toEqual({
      bucket: DECLARED_AGENT_BUCKET,
      kind: "bot",
      contradiction: false,
    });
    expect(applyDeclaration("search:google", "agent").kind).toBe("bot");
  });

  it("leaves an already-detected bot's bucket alone when it declares agent", () => {
    expect(applyDeclaration("bot:gptbot", "agent")).toEqual({ bucket: "bot:gptbot", kind: "bot", contradiction: false });
  });

  it("never lets a declared human override bot detection, and flags it", () => {
    expect(applyDeclaration("bot:gptbot", "human")).toEqual({ bucket: "bot:gptbot", kind: "bot", contradiction: true });
    expect(applyDeclaration("bot:scripted", "human").contradiction).toBe(true);
  });

  it("records a consistent human without changing anything", () => {
    expect(applyDeclaration("human:direct", "human")).toEqual({ bucket: "human:direct", kind: "human", contradiction: false });
  });

  it("is a no-op when undeclared", () => {
    expect(applyDeclaration("referral:x.com", null)).toEqual({ bucket: "referral:x.com", kind: "human", contradiction: false });
  });
});

describe("tokens", () => {
  it("mints cpa_ tokens that pass the shape check and hash deterministically", () => {
    const t = mintActorToken();
    expect(t.plaintext.startsWith("cpa_")).toBe(true);
    expect(isActorTokenShape(t.plaintext)).toBe(true);
    expect(t.prefix).toBe(t.plaintext.slice(0, 8));
    expect(hashActorToken(t.plaintext)).toBe(t.hash);
  });

  it("keeps actor and API token hashes apart under the same pepper", () => {
    expect(hashActorToken(TOKEN)).not.toBe(hashApiToken(TOKEN));
  });

  it("rejects an email, an API token and junk as an actor token", () => {
    expect(isActorTokenShape("anthony@profullstack.com")).toBe(false);
    expect(isActorTokenShape("crp_" + "a".repeat(43))).toBe(false);
    expect(isActorTokenShape("cpa_short")).toBe(false);
    expect(isActorTokenShape("cpa_" + "a".repeat(40) + "<script>")).toBe(false);
  });
});

describe("actorTokenFrom", () => {
  const other = mintActorToken().plaintext;
  const third = mintActorToken().plaintext;

  it("prefers the header over the body", () => {
    expect(actorTokenFrom(new Headers({ [ACTOR_HEADER]: TOKEN }), other)).toBe(TOKEN);
    expect(actorTokenFrom(new Headers(), other)).toBe(other);
  });

  it("ignores cookies: the tracker is cookieless", () => {
    expect(actorTokenFrom(new Headers({ cookie: `crp_actor=${third}` }), null)).toBeNull();
  });

  it("skips a malformed channel instead of failing the beacon", () => {
    expect(actorTokenFrom(new Headers({ [ACTOR_HEADER]: "anthony@profullstack.com" }), TOKEN)).toBe(TOKEN);
    expect(actorTokenFrom(new Headers(), "nope")).toBeNull();
  });

});

describe("resolveActor", () => {
  beforeEach(() => clearActorCache());

  function fakeSb(row: unknown) {
    const maybeSingle = vi.fn(async () => ({ data: row, error: null }));
    const chain = { select: () => chain, eq: () => chain, maybeSingle, update: () => ({ eq: () => ({ then: (f: () => void) => f() }) }) };
    return { sb: { from: () => chain } as never, maybeSingle };
  }

  it("resolves a live token to its actor and caches it", async () => {
    const { sb, maybeSingle } = fakeSb({ id: "t1", revoked_at: null, actor: { id: "a1", kind: "agent", revoked_at: null } });
    expect(await resolveActor(sb, TOKEN)).toEqual({ actorId: "a1", tokenId: "t1", kind: "agent" });
    await resolveActor(sb, TOKEN);
    expect(maybeSingle).toHaveBeenCalledTimes(1);
  });

  it("treats a revoked token or a revoked actor as undeclared", async () => {
    expect(await resolveActor(fakeSb({ id: "t1", revoked_at: "2026-10-01", actor: { id: "a1", kind: "human", revoked_at: null } }).sb, TOKEN)).toBeNull();
    clearActorCache();
    expect(await resolveActor(fakeSb({ id: "t1", revoked_at: null, actor: { id: "a1", kind: "human", revoked_at: "2026-10-01" } }).sb, TOKEN)).toBeNull();
  });

  it("never throws on a failing lookup", async () => {
    const sb = { from: () => { throw new Error("db down"); } } as never;
    expect(await resolveActor(sb, TOKEN)).toBeNull();
  });
});

describe("helpers", () => {
  it("normalizes emails and refuses non-addresses", () => {
    expect(normalizeEmail("  Riotcoder@ProFullStack.com ")).toBe("riotcoder@profullstack.com");
    expect(normalizeEmail("riotcoder")).toBeNull();
    expect(normalizeEmail(42)).toBeNull();
  });

  it("coerces RPC totals per kind and ignores unknown kinds", () => {
    const t = toDeclaredTotals([
      { declared_kind: "agent", actors: "1", events: "40", pageviews: "12", contradictions: "0" },
      { declared_kind: "martian", actors: 9, events: 9, pageviews: 9, contradictions: 9 },
    ]);
    expect(t.agent).toEqual({ actors: 1, events: 40, pageviews: 12, contradictions: 0 });
    expect(t.human).toEqual({ actors: 0, events: 0, pageviews: 0, contradictions: 0 });
  });

  it("maps ranges onto the first UTC day the daily rollup should read", () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(rangeSinceDay(trackerRange("1h"))).toBe(today);
    expect(rangeSinceDay(trackerRange("all"))).toBe("1970-01-01");
    expect(rangeSinceDay(trackerRange("1w")) < today).toBe(true);
  });

  it("labels a declared browser by browser, OS and date", () => {
    const ua = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";
    expect(browserLabel(ua, new Date("2026-10-04T00:00:00Z"))).toBe("Browser: Chrome on Linux, 2026-10-04");
  });

  it("tells a CLI user every channel, and the token once", () => {
    const out = actorTokenHowTo(TOKEN);
    expect(out).toContain(`Crawlproof-Actor: ${TOKEN}`);
    expect(out).toContain(`?crp_actor=${TOKEN}`);
  });
});

describe("/stats.js actor handling", () => {
  it("stores a ?crp_actor= token per site, sends it in the body, and stays credentialless", async () => {
    const { GET } = await import("@/app/stats.js/route");
    const script = await (await GET()).text();
    expect(script).toContain("crawlproof.actor");
    expect(script).toContain("searchParams.delete('crp_actor')");
    expect(script).toContain("actor: lsGet(ACTOR_KEY) || null");
    expect(script).toContain("if (method === 'actor') return setActor(args[0]);");
    expect(script).toContain("credentials: 'omit'");
  });
});

describe("renderStats declared section", () => {
  it("prints declared actors apart from detected traffic, with contradictions", () => {
    const text = renderStats(
      {
        project: { name: "crawlproof.com" },
        totals: { visitors: 10, pageviews: 20, events: 50 },
        declared: {
          totals: {
            human: { actors: 1, events: 5, pageviews: 3, contradictions: 2 },
            agent: { actors: 1, events: 40, pageviews: 12, contradictions: 0 },
          },
          actors: [
            { name: "riotcoder", email: "riotcoder@profullstack.com", kind: "agent", events: 40, pageviews: 12, contradictions: 0 },
          ],
        },
      },
      { range: "1d", who: "humans" },
    );
    expect(text).toContain("Declared (self-reported)");
    expect(text).toContain("humans  1 actor, 3 pageviews, 5 events, 2 contradicted by detection");
    expect(text).toContain("agents  1 actor, 12 pageviews, 40 events");
    expect(text).toContain("riotcoder <riotcoder@profullstack.com>");
  });

  it("prints nothing about declarations when nobody declared", () => {
    const text = renderStats({ project: { name: "x" }, totals: { visitors: 1, pageviews: 1, events: 1 }, declared: null }, { range: "1d", who: "humans" });
    expect(text).not.toContain("Declared");
  });
});

// ------------------------------------------------------------------ ingest

const db = vi.hoisted(() => {
  const calls: { table: string; op: string; payload?: unknown }[] = [];
  const rpc = vi.fn(async (name: string, _args: Record<string, unknown>) => {
    if (name === "tracker_touch_visitor") return { data: [{ kind: _args.p_kind, events: 1, pageviews: 1 }], error: null };
    return { data: null, error: null };
  });
  let rows: Record<string, unknown> = {};
  function from(table: string) {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    Object.assign(chain, {
      select: self, eq: self, lt: self, in: self, gte: self, is: self, order: self, limit: self,
      maybeSingle: async () => ({ data: rows[table] ?? null, error: null }),
      update: (payload: unknown) => { calls.push({ table, op: "update", payload }); return chain; },
      insert: async (payload: unknown) => { calls.push({ table, op: "insert", payload }); return { data: null, error: null }; },
      delete: () => chain,
      then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }),
    });
    return chain;
  }
  return { calls, rpc, from, setRows: (r: Record<string, unknown>) => { rows = r; } };
});

vi.mock("@/lib/supabase/service", () => ({
  serviceClient: () => ({ from: db.from, rpc: db.rpc }),
}));
vi.mock("@/lib/tracker/geo", () => ({ clientIpFromHeaders: () => null, lookupGeo: async () => null }));
vi.mock("@/lib/posthog/events", () => ({ enqueuePostHogEvent: async () => undefined }));

describe("/api/track with a declared actor", () => {
  const SITE = "475e7e62-b048-44da-90b4-746d1ba512d2";
  const CHROME = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";

  beforeEach(() => {
    clearActorCache();
    db.calls.length = 0;
    db.rpc.mockClear();
  });

  async function beacon(kind: "human" | "agent", ua: string) {
    db.setRows({
      projects: { id: SITE, owner_id: "u1", organization_id: null, url: "https://example.com", tracker_enabled: true },
      tracker_actor_tokens: { id: "t1", revoked_at: null, actor: { id: "a1", kind, revoked_at: null } },
    });
    const { POST } = await import("@/app/api/track/route");
    const res = await POST(
      new Request("https://crawlproof.com/api/track", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://example.com", "user-agent": ua, [ACTOR_HEADER]: TOKEN },
        body: JSON.stringify({ site: SITE, type: "pageview", href: "https://example.com/", visitorId: "v1", sessionId: "s1" }),
      }) as NextRequest,
    );
    expect(res.status).toBe(204);
    await new Promise((r) => setTimeout(r, 0));
    return db.rpc.mock.calls as [string, Record<string, unknown>][];
  }

  it("counts a declared agent in stock Chrome as a bot everywhere, visitor rollup included", async () => {
    const calls = await beacon("agent", CHROME);
    const visitor = calls.find(([n]) => n === "tracker_touch_visitor")![1];
    expect(visitor.p_kind).toBe("bot");
    const actor = calls.find(([n]) => n === "tracker_touch_actor")![1];
    expect(actor).toMatchObject({ p_actor: "a1", p_declared_kind: "agent", p_pageview: true, p_contradiction: false });
    const bucketRow = db.calls.find((c) => c.table === "tracker_daily_stats" && c.op === "insert")!.payload as { bucket: string };
    expect(bucketRow.bucket).toBe(DECLARED_AGENT_BUCKET);
    const raw = db.calls.find((c) => c.table === "tracker_events" && c.op === "insert")!.payload as { actor_id: string };
    expect(raw.actor_id).toBe("a1");
  });

  it("keeps a declared human with a crawler user agent on the bot side, as a contradiction", async () => {
    const calls = await beacon("human", "GPTBot/1.2 (+https://openai.com/gptbot)");
    const actor = calls.find(([n]) => n === "tracker_touch_actor")![1];
    expect(actor).toMatchObject({ p_declared_kind: "human", p_contradiction: true });
    const bucketRow = db.calls.find((c) => c.table === "tracker_daily_stats" && c.op === "insert")!.payload as { bucket: string };
    expect(bucketRow.bucket.startsWith("bot:")).toBe(true);
  });

  it("leaves a consistent declared human counted as human", async () => {
    const calls = await beacon("human", CHROME);
    expect(calls.find(([n]) => n === "tracker_touch_visitor")![1].p_kind).toBe("human");
    expect(calls.find(([n]) => n === "tracker_touch_actor")![1].p_contradiction).toBe(false);
  });
});

describe("runActors (shared by both CLIs)", () => {
  function harness(reply: { status: number; json: Record<string, unknown> }) {
    const calls: [string, string, Record<string, unknown> | undefined][] = [];
    const lines: string[] = [];
    const errors: string[] = [];
    const call = async (method: string, path: string, body?: Record<string, unknown>) => {
      calls.push([method, path, body]);
      return reply;
    };
    return { calls, lines, errors, out: { write: (l: string) => lines.push(l), error: (l: string) => errors.push(l) }, call };
  }

  it("runs `actors add <email> --kind=agent --operator=<email>` as one POST", async () => {
    const h = harness({ status: 201, json: { actor: { id: "a2", email: "riotcoder@profullstack.com", kind: "agent" }, verification: "sent", token: TOKEN } });
    const code = await runActors(["add", "riotcoder@profullstack.com"], { kind: "agent", operator: "anthony@profullstack.com" }, h.call, h.out);
    expect(code).toBe(0);
    expect(h.calls).toEqual([["POST", "/api/tracker/v1/actors", { email: "riotcoder@profullstack.com", kind: "agent", visibility: "private", operator: "anthony@profullstack.com", token_label: "cli" }]]);
    expect(h.lines.join("\n")).toContain("verification email sent");
    expect(h.lines.join("\n")).toContain(`Crawlproof-Actor: ${TOKEN}`);
  });

  it("says why when the server refuses, e.g. an actor that already exists", async () => {
    const h = harness({ status: 409, json: { error: "anthony@profullstack.com is already an actor on this account." } });
    expect(await runActors(["add", "anthony@profullstack.com"], { kind: "human" }, h.call, h.out)).toBe(1);
    expect(h.errors[0]).toBe("actors add failed: 409 anthony@profullstack.com is already an actor on this account.");
  });

  it("prints usage without --kind instead of guessing", async () => {
    const h = harness({ status: 200, json: {} });
    expect(await runActors(["add", "x@example.com"], {}, h.call, h.out)).toBe(2);
    expect(h.calls).toEqual([]);
  });

  it("is wired into the published CLI, not only the in-repo one", () => {
    const src = readFileSync("packages/cli/src/cli.ts", "utf8");
    expect(src).toContain('case "actors":');
    expect(src).toContain('export const VERSION = "0.5.0";');
  });
});
