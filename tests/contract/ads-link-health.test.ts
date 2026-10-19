import { describe, expect, it } from "vitest";
import {
  DEAD_GRACE_MS,
  DEAD_LINK_REASON,
  classifyLink,
  isCheckable,
  nextLinkState,
  probeAll,
  probeLink,
} from "@/lib/ads/linkHealth";

const HOUR = 60 * 60 * 1000;
const now = Date.parse("2026-10-19T12:00:00Z");
const live = { status: "active", paused_reason: null, link_dead_since: null, link_dead_checks: 0 };
const dead = { verdict: "dead" as const, httpStatus: 404, error: null };
const ok = { verdict: "ok" as const, httpStatus: 200, error: null };
const unknown = { verdict: "unknown" as const, httpStatus: 402, error: null };

describe("classifyLink", () => {
  it("only calls a page dead on 404, 410 or a domain that no longer resolves", () => {
    expect(classifyLink(200)).toBe("ok");
    expect(classifyLink(301)).toBe("ok");
    expect(classifyLink(404)).toBe("dead");
    expect(classifyLink(410)).toBe("dead");
    expect(classifyLink(null, "ENOTFOUND")).toBe("dead");
    // The fleet's crawl gate, bot walls, rate limits and outages say nothing.
    for (const s of [401, 402, 403, 429, 500, 503, 999]) expect(classifyLink(s)).toBe("unknown");
    for (const c of ["ECONNREFUSED", "TimeoutError", "ECONNRESET"]) expect(classifyLink(null, c)).toBe("unknown");
  });
  it("skips onion and non-http links", () => {
    expect(isCheckable("http://abc.onion/")).toBe(false);
    expect(isCheckable("mailto:a@b.c")).toBe(false);
    expect(isCheckable("not a url")).toBe(false);
    expect(isCheckable("https://pwamart.com/apps/x")).toBe(true);
  });
});

describe("nextLinkState", () => {
  it("does not pause on a single dead check", () => {
    const s = nextLinkState(live, dead, now);
    expect(s).toMatchObject({ link_status: "dead", link_dead_checks: 1, action: null });
    expect(s.link_dead_since).toBe(new Date(now).toISOString());
  });
  it("pauses after two dead checks at least the grace period apart", () => {
    const since = new Date(now - DEAD_GRACE_MS).toISOString();
    expect(nextLinkState({ ...live, link_dead_since: since, link_dead_checks: 1 }, dead, now).action).toBe("pause");
    const recent = new Date(now - 2 * HOUR).toISOString();
    expect(nextLinkState({ ...live, link_dead_since: recent, link_dead_checks: 5 }, dead, now).action).toBeNull();
  });
  it("an unknown answer neither advances nor resets the dead streak", () => {
    const since = new Date(now - 20 * HOUR).toISOString();
    const s = nextLinkState({ ...live, link_dead_since: since, link_dead_checks: 1 }, unknown, now);
    expect(s).toMatchObject({ link_status: "unknown", link_dead_since: since, link_dead_checks: 1, action: null });
  });
  it("resumes only campaigns it paused itself", () => {
    expect(nextLinkState({ ...live, status: "paused", paused_reason: DEAD_LINK_REASON }, ok, now).action).toBe("resume");
    expect(nextLinkState({ ...live, status: "paused", paused_reason: null }, ok, now).action).toBeNull();
    expect(nextLinkState(live, ok, now)).toMatchObject({ link_status: "ok", link_dead_checks: 0, link_dead_since: null });
  });
  it("never pauses a draft or hand-paused campaign", () => {
    const since = new Date(now - 2 * DEAD_GRACE_MS).toISOString();
    for (const status of ["draft", "paused"]) {
      expect(nextLinkState({ ...live, status, link_dead_since: since, link_dead_checks: 3 }, dead, now).action).toBeNull();
    }
  });
});

describe("probing", () => {
  it("reads a fetch failure's cause code", async () => {
    const nx = async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    };
    expect(await probeLink("https://gone.example/", nx)).toEqual({ verdict: "dead", httpStatus: null, error: "ENOTFOUND" });
    expect((await probeLink("http://x.onion/", nx)).verdict).toBe("unknown");
  });
  it("fetches each URL once and spaces requests to one host", async () => {
    const calls: string[] = [];
    const sleeps: number[] = [];
    const fetchImpl = async (url: string) => {
      calls.push(url);
      return new Response(null, { status: url.endsWith("gone") ? 404 : 200 });
    };
    const r = await probeAll(
      ["https://a.test/1", "https://a.test/gone", "https://a.test/1", "https://b.test/"],
      { fetchImpl, gapMs: 2000, sleep: async (ms) => void sleeps.push(ms) },
    );
    expect(calls.sort()).toEqual(["https://a.test/1", "https://a.test/gone", "https://b.test/"]);
    expect(sleeps).toEqual([2000]);
    expect(r.get("https://a.test/gone")?.verdict).toBe("dead");
    expect(r.get("https://b.test/")?.verdict).toBe("ok");
  });
  it("hands each answer over as it lands, before the batch finishes", async () => {
    const seen: string[] = [];
    let fetched = 0;
    const fetchImpl = async () => {
      fetched++;
      return new Response(null, { status: 200 });
    };
    await probeAll(["https://a.test/1", "https://a.test/2"], {
      fetchImpl,
      gapMs: 1,
      sleep: async () => void expect(seen).toHaveLength(fetched),
      onProbe: async (url) => void seen.push(url),
    });
    expect(seen).toEqual(["https://a.test/1", "https://a.test/2"]);
  });
});
