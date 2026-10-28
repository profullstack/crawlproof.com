// @vitest-environment node
// The autoblog delivery on the @profullstack/webhooks hub: receivers built on
// @profullstack/autoblog's verifyAndParse (every crawlproof customer blog) must
// keep verifying with the secret they already have, and the article row must
// still say how delivery went.
import { describe, it, expect } from "vitest";
import { verifyAndParse as autoblogVerify } from "@profullstack/autoblog";
import { memoryStore, verifyAndParse, type Endpoint } from "@profullstack/webhooks";
import {
  createHub,
  bearerFor,
  storedSecretFor,
  syncSiteEndpoint,
  siteEndpointConfig,
  POST_PUBLISHED,
} from "@/lib/webhooks/hub";
import { fakeSupabase } from "./fake-supabase";

const guard = { lookup: async () => ["93.184.216.34"] };
type Sent = { url: string; headers: Record<string, string>; body: string };

function harness(respond: (n: number) => number = () => 204) {
  const db = fakeSupabase();
  const sent: Sent[] = [];
  const fetchImpl = (async (url: string | URL, init: RequestInit) => {
    sent.push({ url: String(url), headers: Object.fromEntries(new Headers(init.headers).entries()), body: String(init.body) });
    return new Response(null, { status: respond(sent.length) });
  }) as typeof fetch;
  let now = 1_800_000_000_000;
  const hub = createHub(db as never, { store: memoryStore(), guard, fetchImpl, now: () => now });
  return { db, hub, sent, tick: (ms: number) => (now += ms) };
}

const endpoint = (secret: string, over: Partial<Endpoint> = {}): Endpoint => ({
  id: "wh_lx_site1",
  owner: "site-1",
  url: "https://blog.example.com/api/webhooks/crawlproof",
  secret,
  events: [POST_PUBLISHED],
  description: "autoblog: blog.example.com",
  enabled: true,
  failures: 0,
  disabledReason: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const post = {
  id: "art-1",
  url: "https://blog.example.com/blog/hello",
  canonical_url: "https://blog.example.com/blog/hello",
  title: "Hello",
  slug: "hello",
  excerpt: "x",
  html: "<p>Hello</p>",
  markdown: "Hello",
  status: "published",
  published_at: "2026-10-28T00:00:00.000Z",
  updated_at: "2026-10-28T00:00:00.000Z",
  author: null,
  tags: ["t"],
  categories: [],
  featured_image: null,
};

function headersOf(s: Sent) {
  return s.headers;
}

describe("autoblog receivers keep verifying", () => {
  it("an old-style receiver (autoblog verifyAndParse, whole-string key + bearer) verifies a hub delivery", async () => {
    const { hub, sent } = harness();
    const secret = ["receiver", "generated", "token", "7f3a9c2e1b"].join("-"); // test fixture shaped like prod: a plain string
    await hub.store.insertEndpoint(endpoint(secret));
    const r = await hub.hooks.emit("site-1", POST_PUBLISHED, { post }, { subject: "post:art-1", id: "evt-1" });
    expect(r.queued).toBe(1);
    await hub.hooks.drain();
    expect(sent).toHaveLength(1);
    const got = autoblogVerify({ headers: headersOf(sent[0]), body: sent[0].body, opts: { secret } });
    expect(got.ok).toBe(true);
    if (got.ok) {
      expect(got.post.id).toBe("art-1");
      expect(got.event.type).toBe("com.crawlproof.post.published.v1");
      expect(got.event.subject).toBe("post:art-1");
      expect(got.event.id).toBe("evt-1");
    }
    expect(sent[0].headers.authorization).toBe(`Bearer ${secret}`);
    expect(sent[0].headers["webhook-id"]).toBe("evt-1");
    // ...and a receiver on @profullstack/webhooks verifies the same request.
    expect(verifyAndParse({ headers: sent[0].headers, body: sent[0].body, secret }).ok).toBe(true);
  });

  it("a typed secret that itself starts with whsec_ keeps its whole-string key", async () => {
    const { hub, sent } = harness();
    const typed = "whsec_not-really-base64-but-typed-by-a-human";
    const stored = storedSecretFor(typed);
    expect(stored).not.toBe(typed);
    expect(bearerFor(stored)).toBe(typed);
    await hub.store.insertEndpoint(endpoint(stored));
    await hub.hooks.emit("site-1", POST_PUBLISHED, { post });
    await hub.hooks.drain();
    expect(autoblogVerify({ headers: sent[0].headers, body: sent[0].body, opts: { secret: typed } }).ok).toBe(true);
  });

  it("a hub-generated secret is sent as the bearer and verifies with @profullstack/webhooks", async () => {
    const { hub, sent } = harness();
    const { endpoint: e, secret } = await hub.hooks.createEndpoint("site-1", { url: "https://hooks.example.com/x", events: [POST_PUBLISHED] });
    expect(bearerFor(secret)).toBe(secret);
    await hub.hooks.emit("site-1", POST_PUBLISHED, { post });
    await hub.hooks.drain();
    expect(sent[0].headers.authorization).toBe(`Bearer ${secret}`);
    expect(verifyAndParse({ headers: sent[0].headers, body: sent[0].body, secret }).ok).toBe(true);
    expect(e.events).toEqual([POST_PUBLISHED]);
  });

  it("a post goes only to the endpoints of the site it is for", async () => {
    const { hub, sent } = harness();
    await hub.store.insertEndpoint(endpoint("secret-one-xxxxxxxxxxxx"));
    await hub.store.insertEndpoint(endpoint("secret-two-xxxxxxxxxxxx", { id: "wh_other", owner: "site-2", url: "https://other.example.com/hook" }));
    await hub.hooks.emit("site-1", POST_PUBLISHED, { post });
    await hub.hooks.drain();
    expect(sent.map((s) => s.url)).toEqual(["https://blog.example.com/api/webhooks/crawlproof"]);
  });
});

describe("article status follows the delivery", () => {
  function seedArticle(db: ReturnType<typeof fakeSupabase>) {
    db.rows("lx_article").push({ id: "art-1", status: "publishing", webhook_delivery_id: "evt-1", published_at: null, created_at: "2026-10-27T10:00:00.000Z" });
    db.rows("lx_keyword").push({ id: "kw-1", article_id: "art-1", status: "generating" });
  }

  it("2xx: published, with code, attempts and published_at", async () => {
    const { db, hub } = harness();
    seedArticle(db);
    await hub.store.insertEndpoint(endpoint("secret-one-xxxxxxxxxxxx"));
    await hub.hooks.emit("site-1", POST_PUBLISHED, { post }, { id: "evt-1" });
    await hub.hooks.drain();
    expect(db.rows("lx_article")[0]).toMatchObject({
      status: "published",
      webhook_response_code: 204,
      webhook_attempts: 1,
      webhook_last_error: null,
      published_at: "2026-10-27T10:00:00.000Z",
    });
    expect(db.rows("lx_keyword")[0].status).toBe("published");
  });

  it("422 (receiver's quality gate) is final, as with the old sender", async () => {
    const { db, hub, sent, tick } = harness(() => 422);
    seedArticle(db);
    await hub.store.insertEndpoint(endpoint("secret-one-xxxxxxxxxxxx"));
    await hub.hooks.emit("site-1", POST_PUBLISHED, { post }, { id: "evt-1" });
    await hub.hooks.drain();
    tick(120_000);
    await hub.hooks.drain();
    expect(sent).toHaveLength(1);
    expect(db.rows("lx_article")[0]).toMatchObject({ status: "failed", webhook_response_code: 422, webhook_attempts: 1 });
    expect(db.rows("lx_keyword")[0].status).toBe("failed");
    expect((await hub.hooks.deliveries("site-1"))[0].status).toBe("failed");
  });

  it("5xx retries at +10s and +60s, then publishes on success", async () => {
    const { db, hub, sent, tick } = harness((n) => (n < 3 ? 503 : 200));
    seedArticle(db);
    await hub.store.insertEndpoint(endpoint("secret-one-xxxxxxxxxxxx"));
    await hub.hooks.emit("site-1", POST_PUBLISHED, { post }, { id: "evt-1" });
    await hub.hooks.drain();
    expect(db.rows("lx_article")[0]).toMatchObject({ status: "publishing", webhook_attempts: 1 });
    tick(10_000);
    await hub.hooks.drain();
    tick(60_000);
    await hub.hooks.drain();
    expect(sent).toHaveLength(3);
    expect(db.rows("lx_article")[0]).toMatchObject({ status: "published", webhook_attempts: 3, webhook_response_code: 200 });
  });

  it("5xx three times: failed", async () => {
    const { db, hub, tick } = harness(() => 500);
    seedArticle(db);
    await hub.store.insertEndpoint(endpoint("secret-one-xxxxxxxxxxxx"));
    await hub.hooks.emit("site-1", POST_PUBLISHED, { post }, { id: "evt-1" });
    for (const ms of [0, 10_000, 60_000]) {
      tick(ms);
      await hub.hooks.drain();
    }
    expect(db.rows("lx_article")[0]).toMatchObject({ status: "failed", webhook_attempts: 3, webhook_response_code: 500 });
  });
});

describe("syncSiteEndpoint (the /autoblog/setup URL + secret)", () => {
  it("creates one endpoint per site, then only writes what changed", async () => {
    const { db, hub } = harness();
    db.rows("lx_site").push({ id: "11111111-2222-3333-4444-555555555555", webhook_endpoint_id: null });
    const site = { id: "11111111-2222-3333-4444-555555555555", domain: "blog.example.com", webhook_endpoint_id: null as string | null };
    const r = await syncSiteEndpoint(db as never, site, { url: "https://blog.example.com/hook", secret: "typed-secret-1234567890" }, hub, guard);
    expect(r).toEqual({ endpointId: "wh_lx_11111111222233334444555555555555" });
    expect(db.rows("lx_site")[0].webhook_endpoint_id).toBe(r.endpointId);
    site.webhook_endpoint_id = r.endpointId;

    // A rotate through the API, then a setup save that shows (and re-sends) the rotated secret: no change.
    const { secret } = await hub.hooks.rotateSecret(site.id, r.endpointId!);
    const shown = await siteEndpointConfig(r.endpointId, hub);
    expect(shown?.secret).toBe(secret);
    await syncSiteEndpoint(db as never, site, { url: shown!.url, secret: shown!.secret }, hub, guard);
    expect((await hub.store.getEndpoint(r.endpointId!))!.secret).toBe(secret);

    // The customer types a new secret: stored so its key bytes are that string.
    await syncSiteEndpoint(db as never, site, { url: "https://blog.example.com/hook2", secret: ["whsec", "typed"].join("_") }, hub, guard);
    const e = (await hub.store.getEndpoint(r.endpointId!))!;
    expect(e.url).toBe("https://blog.example.com/hook2");
    expect(bearerFor(e.secret)).toBe("whsec_typed");
  });

  it("refuses a private address", async () => {
    const { db, hub } = harness();
    const r = await syncSiteEndpoint(
      db as never,
      { id: "s", domain: "d", webhook_endpoint_id: null },
      { url: "https://intranet.example.com/hook", secret: "typed-secret-1234567890" },
      hub,
      { lookup: async () => ["10.0.0.5"] },
    );
    expect(r.error).toMatch(/Webhook URL/);
  });
});
