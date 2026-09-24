import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  find: vi.fn(),
  insert: vi.fn(),
  first: vi.fn(),
  list: vi.fn(),
}));

vi.mock("@/lib/emailTracking/store", () => ({
  findByTrackingId: mocks.find,
  insertEvent: mocks.insert,
  firstSighting: mocks.first,
  listEvents: mocks.list,
}));

import {
  PIXEL_PNG,
  isLikelyMachineOpen,
  isMachineAgent,
  safeHttpUrl,
  sign,
  verifySig,
} from "@/lib/emailTracking/core";
import { isEmailTrackingPath } from "@/lib/crawl-policy";
import { GET as pixelGET } from "@/app/t/[trackingId]/o.png/route";
import { GET as clickGET } from "@/app/t/[trackingId]/c/route";
import { GET as unsubGET, POST as unsubPOST } from "@/app/t/[trackingId]/u/route";
import { GET as eventsGET } from "@/app/api/v1/tracking/[trackingId]/events/route";

const TID = "a1b2c3d4e5f60718293a4b5c";
const SECRET = "11".repeat(32);
const OLD_SECRET = "22".repeat(32);
const BASE = `https://crawlproof.com/t/${TID}`;
const HUMAN_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

const params = (trackingId = TID) => ({ params: Promise.resolve({ trackingId }) });

function row(over: Partial<Record<string, unknown>> = {}) {
  return {
    project_id: "proj-1",
    tracking_id: TID,
    secret: SECRET,
    previous_secret: null,
    secret_rotated_at: null,
    enabled: true,
    enabled_at: null,
    ...over,
  };
}

const ref = (secret: string, value: string) =>
  crypto.createHmac("sha256", secret).update(value).digest("hex").slice(0, 32);

beforeEach(() => {
  mocks.find.mockReset().mockResolvedValue(row());
  mocks.insert.mockReset().mockResolvedValue(true);
  mocks.first.mockReset().mockResolvedValue(null);
  mocks.list.mockReset().mockResolvedValue([]);
});

describe("signatures", () => {
  it("is the first 32 hex chars of HMAC-SHA256(secret, value)", () => {
    const u = "https://example.com/pricing?a=1&b=2";
    expect(sign(SECRET, u)).toBe(ref(SECRET, u));
    expect(sign(SECRET, u)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("accepts the right sig in any hex case, and the previous secret", () => {
    const v = "https://example.com/";
    expect(verifySig([SECRET], v, ref(SECRET, v))).toBe(true);
    expect(verifySig([SECRET], v, ref(SECRET, v).toUpperCase())).toBe(true);
    expect(verifySig([SECRET, OLD_SECRET], v, ref(OLD_SECRET, v))).toBe(true);
  });

  it("rejects a wrong, truncated, missing or other-secret sig", () => {
    const v = "https://example.com/";
    expect(verifySig([SECRET], v, ref(OLD_SECRET, v))).toBe(false);
    expect(verifySig([SECRET], v, ref(SECRET, v).slice(0, 31))).toBe(false);
    expect(verifySig([SECRET], v, null)).toBe(false);
    expect(verifySig([SECRET], v, "")).toBe(false);
    expect(verifySig([SECRET], `${v}x`, ref(SECRET, v))).toBe(false);
    expect(verifySig([null, undefined], v, ref(SECRET, v))).toBe(false);
  });

  it("only allows absolute http(s) destinations", () => {
    expect(safeHttpUrl("https://example.com/x")).toBe("https://example.com/x");
    expect(safeHttpUrl("http://example.com")).toBe("http://example.com/");
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("data:text/html,hi")).toBeNull();
    expect(safeHttpUrl("//evil.example")).toBeNull();
    expect(safeHttpUrl("/relative")).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
  });
});

describe("machine opens", () => {
  it("flags mail proxies and Apple MPP by user agent", () => {
    expect(isMachineAgent("Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)")).toBe(true);
    expect(isMachineAgent("Mozilla/5.0")).toBe(true);
    expect(isMachineAgent("YahooMailProxy; https://help.yahoo.com/kb/yahoo-mail-proxy-SLN28749.html")).toBe(true);
    expect(isMachineAgent("")).toBe(true);
    expect(isMachineAgent(HUMAN_UA)).toBe(false);
  });

  it("flags an open within a few seconds of the message's first sighting", () => {
    const now = new Date("2026-09-24T12:00:10Z");
    expect(isLikelyMachineOpen({ userAgent: HUMAN_UA, firstSeenAt: new Date("2026-09-24T12:00:08Z"), now })).toBe(true);
    expect(isLikelyMachineOpen({ userAgent: HUMAN_UA, firstSeenAt: new Date("2026-09-24T11:00:00Z"), now })).toBe(false);
    expect(isLikelyMachineOpen({ userAgent: HUMAN_UA, firstSeenAt: null, now })).toBe(false);
  });
});

describe("open pixel always answers 200 with a PNG", () => {
  async function expectPixel(res: Response) {
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("cache-control")).toContain("no-cache");
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(PIXEL_PNG)).toBe(true);
    expect(body.subarray(1, 4).toString()).toBe("PNG");
  }

  it("records an open when enabled", async () => {
    const res = await pixelGET(
      new Request(`${BASE}/o.png?m=msg-1&c=launch&v=a`, { headers: { "user-agent": HUMAN_UA } }),
      params(),
    );
    await expectPixel(res);
    expect(mocks.insert).toHaveBeenCalledTimes(1);
    expect(mocks.insert.mock.calls[0][0]).toMatchObject({
      project_id: "proj-1",
      type: "open",
      m: "msg-1",
      c: "launch",
      v: "a",
      machine: false,
    });
    // No IP in the clear, ever.
    expect(JSON.stringify(mocks.insert.mock.calls[0][0])).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });

  it("marks a Gmail proxy fetch as machine instead of dropping it", async () => {
    await pixelGET(
      new Request(`${BASE}/o.png?m=msg-1`, { headers: { "user-agent": "Mozilla/5.0 (via ggpht.com GoogleImageProxy)" } }),
      params(),
    );
    expect(mocks.insert.mock.calls[0][0]).toMatchObject({ type: "open", machine: true });
  });

  it("serves the pixel and records nothing when disabled", async () => {
    mocks.find.mockResolvedValue(row({ enabled: false }));
    await expectPixel(await pixelGET(new Request(`${BASE}/o.png?m=x`), params()));
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("serves the pixel for an unknown or malformed id", async () => {
    mocks.find.mockResolvedValue(null);
    await expectPixel(await pixelGET(new Request(`${BASE}/o.png`), params()));
    await expectPixel(await pixelGET(new Request("https://crawlproof.com/t/x/o.png"), params("x")));
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("serves the pixel when the database is down", async () => {
    mocks.find.mockRejectedValue(new Error("boom"));
    await expectPixel(await pixelGET(new Request(`${BASE}/o.png?m=x`), params()));
  });
});

describe("click redirect never becomes an open redirect", () => {
  const target = "https://example.com/pricing?ref=mail";
  const clickUrl = (u: string, s?: string) =>
    `${BASE}/c?u=${encodeURIComponent(u)}&m=msg-1&c=launch&v=b${s === undefined ? "" : `&s=${s}`}`;

  it("302s to u and records a click with a valid sig", async () => {
    const res = await clickGET(new Request(clickUrl(target, ref(SECRET, target))), params());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(target);
    expect(mocks.insert.mock.calls[0][0]).toMatchObject({ type: "click", url: target, m: "msg-1", c: "launch", v: "b" });
  });

  it("still redirects a signed link after a rotation (previous secret)", async () => {
    mocks.find.mockResolvedValue(row({ secret: "33".repeat(32), previous_secret: SECRET }));
    const res = await clickGET(new Request(clickUrl(target, ref(SECRET, target))), params());
    expect(res.status).toBe(302);
  });

  it("does not redirect on a bad sig: shows the link as plain text", async () => {
    const evil = "https://evil.example/phish";
    const res = await clickGET(new Request(clickUrl(evil, ref(SECRET, target))), params());
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("https://evil.example/phish");
    expect(html).not.toMatch(/<a\s/i);
    expect(html).not.toMatch(/http-equiv="refresh"/i);
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("does not redirect with a missing sig or an unknown id", async () => {
    expect((await clickGET(new Request(clickUrl(target)), params())).status).toBe(400);
    mocks.find.mockResolvedValue(null);
    const res = await clickGET(new Request(clickUrl(target, ref(SECRET, target))), params());
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("refuses non-http(s) destinations even when signed", async () => {
    const js = "javascript:alert(document.cookie)";
    const res = await clickGET(new Request(clickUrl(js, ref(SECRET, js))), params());
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    const html = await res.text();
    expect(html).not.toContain("<script");
  });

  it("escapes the shown link", async () => {
    const u = 'https://example.com/"><script>alert(1)</script>';
    const res = await clickGET(new Request(clickUrl(u, "0".repeat(32))), params());
    expect(await res.text()).not.toContain("<script>alert(1)");
  });

  it("redirects a signed link without recording when tracking is off", async () => {
    mocks.find.mockResolvedValue(row({ enabled: false }));
    const res = await clickGET(new Request(clickUrl(target, ref(SECRET, target))), params());
    expect(res.status).toBe(302);
    expect(mocks.insert).not.toHaveBeenCalled();
  });
});

describe("unsubscribe", () => {
  const email = "Person@Example.com";
  const unsubUrl = (s: string) => `${BASE}/u?m=msg-1&c=launch&e=${encodeURIComponent(email)}&s=${s}`;
  const good = () => ref(SECRET, email.toLowerCase());

  it("GET shows a confirmation page and records nothing", async () => {
    const res = await unsubGET(new Request(unsubUrl(good())), params());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('method="post"');
    expect(html).toContain("person@example.com");
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("POST records the unsubscribe even while tracking is disabled", async () => {
    mocks.find.mockResolvedValue(row({ enabled: false }));
    const res = await unsubPOST(
      new Request(unsubUrl(good()), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
      }),
      params(),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("You are unsubscribed");
    expect(mocks.insert).toHaveBeenCalledTimes(1);
    expect(mocks.insert.mock.calls[0][0]).toMatchObject({
      project_id: "proj-1",
      type: "unsubscribe",
      email: "person@example.com",
      m: "msg-1",
      c: "launch",
    });
  });

  it("a repeat unsubscribe is still a success", async () => {
    mocks.insert.mockResolvedValue(false);
    const res = await unsubPOST(new Request(unsubUrl(good()), { method: "POST" }), params());
    expect(res.status).toBe(200);
  });

  it("invalid sig is a 400 and records nothing, on GET and POST", async () => {
    const bad = ref(SECRET, email); // signed the mixed-case address, not lowercase(e)
    expect((await unsubGET(new Request(unsubUrl(bad)), params())).status).toBe(400);
    expect((await unsubPOST(new Request(unsubUrl(bad), { method: "POST" }), params())).status).toBe(400);
    expect((await unsubPOST(new Request(`${BASE}/u?e=${encodeURIComponent(email)}`, { method: "POST" }), params())).status).toBe(400);
    mocks.find.mockResolvedValue(null);
    expect((await unsubPOST(new Request(unsubUrl(good()), { method: "POST" }), params())).status).toBe(400);
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("does not claim success when the write fails", async () => {
    mocks.insert.mockRejectedValue(new Error("down"));
    const res = await unsubPOST(new Request(unsubUrl(good()), { method: "POST" }), params());
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("You are unsubscribed");
  });
});

describe("events API auth", () => {
  const eventsUrl = (q = "") => `https://crawlproof.com/api/v1/tracking/${TID}/events${q}`;
  const authed = (q = "", token = SECRET) =>
    new Request(eventsUrl(q), { headers: { authorization: `Bearer ${token}` } });

  it("401s with no token, a wrong token, or an unknown id", async () => {
    expect((await eventsGET(new Request(eventsUrl()), params())).status).toBe(401);
    expect((await eventsGET(authed("", OLD_SECRET), params())).status).toBe(401);
    mocks.find.mockResolvedValue(null);
    expect((await eventsGET(authed(), params())).status).toBe(401);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("does not accept the previous secret as a bearer token", async () => {
    mocks.find.mockResolvedValue(row({ secret: "33".repeat(32), previous_secret: SECRET }));
    expect((await eventsGET(authed(), params())).status).toBe(401);
  });

  it("returns shaped events for the right secret, even when tracking is off", async () => {
    mocks.find.mockResolvedValue(row({ enabled: false }));
    mocks.list.mockResolvedValue([
      { id: 1, type: "open", m: "a", c: "x", v: "1", url: null, email: null, machine: true, at: "2026-09-24T00:00:00Z" },
      { id: 2, type: "click", m: "a", c: "x", v: "1", url: "https://e.com/", email: null, machine: false, at: "2026-09-24T00:01:00Z" },
      { id: 3, type: "unsubscribe", m: "a", c: "x", v: null, url: null, email: "p@e.com", machine: false, at: "2026-09-24T00:02:00Z" },
    ]);
    const res = await eventsGET(authed("?since=2026-09-01T00:00:00Z"), params());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.next).toBeNull();
    expect(body.events).toEqual([
      { type: "open", m: "a", c: "x", v: "1", machine: true, at: "2026-09-24T00:00:00Z" },
      { type: "click", m: "a", c: "x", v: "1", url: "https://e.com/", machine: false, at: "2026-09-24T00:01:00Z" },
      { type: "unsubscribe", m: "a", c: "x", v: null, email: "p@e.com", at: "2026-09-24T00:02:00Z" },
    ]);
    expect(mocks.list.mock.calls[0][0]).toMatchObject({
      projectId: "proj-1",
      since: "2026-09-01T00:00:00.000Z",
      type: null,
      afterId: null,
    });
  });

  it("paginates with a next URL that carries the filters", async () => {
    mocks.list.mockResolvedValue([
      { id: 7, type: "unsubscribe", m: null, c: null, v: null, url: null, email: "a@b.co", machine: false, at: "2026-09-24T00:00:00Z" },
      { id: 9, type: "unsubscribe", m: null, c: null, v: null, url: null, email: "c@d.co", machine: false, at: "2026-09-24T00:00:01Z" },
    ]);
    const body = await (await eventsGET(authed("?type=unsubscribe&limit=2"), params())).json();
    const next = new URL(body.next);
    expect(next.pathname).toBe(`/api/v1/tracking/${TID}/events`);
    expect(next.searchParams.get("cursor")).toBe("9");
    expect(next.searchParams.get("type")).toBe("unsubscribe");
    expect(next.searchParams.get("limit")).toBe("2");

    await eventsGET(authed(`?type=unsubscribe&limit=2&cursor=9`), params());
    expect(mocks.list.mock.calls[1][0]).toMatchObject({ type: "unsubscribe", afterId: 9, limit: 2 });
  });

  it("400s on a bad type, since or cursor", async () => {
    expect((await eventsGET(authed("?type=delete"), params())).status).toBe(400);
    expect((await eventsGET(authed("?since=yesterday"), params())).status).toBe(400);
    expect((await eventsGET(authed("?cursor=abc"), params())).status).toBe(400);
  });
});

describe("proxy bypass", () => {
  it("covers the tracking routes only", () => {
    expect(isEmailTrackingPath(`/t/${TID}/c`)).toBe(true);
    expect(isEmailTrackingPath(`/api/v1/tracking/${TID}/events`)).toBe(true);
    expect(isEmailTrackingPath("/tools")).toBe(false);
    expect(isEmailTrackingPath("/dashboard/projects/x/tracking")).toBe(false);
  });
});
