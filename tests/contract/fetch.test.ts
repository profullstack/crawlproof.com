import { describe, it, expect, afterEach, vi } from "vitest";
import { fetchPage, probeText } from "@/lib/audit/fetch";

describe("fetchPage", () => {
  let originalFetch: typeof globalThis.fetch;

  afterEach(() => {
    if (originalFetch) globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("sends CrawlProofBot user agent and follows redirects", async () => {
    originalFetch = globalThis.fetch;
    const seen: RequestInit[] = [];
    globalThis.fetch = vi.fn(async (_url, init) => {
      seen.push(init as RequestInit);
      return new Response("<html><body>ok</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as unknown as typeof globalThis.fetch;

    const p = await fetchPage("https://example.com");
    expect(p.status).toBe(200);
    expect(p.rawHtml).toContain("<body>");
    expect(p.contentType).toMatch(/text\/html/);
    expect(seen[0]?.redirect).toBe("follow");
    const headers = seen[0]?.headers as Record<string, string>;
    expect(headers["user-agent"]).toMatch(/^CrawlProofBot\/1\.0/);
    expect(p.fetchMs).toBeGreaterThanOrEqual(0);
  });

  it("returns status 0 and an error message when fetch throws", async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      throw new Error("connection refused");
    }) as unknown as typeof globalThis.fetch;
    const p = await fetchPage("https://example.com");
    expect(p.status).toBe(0);
    expect(p.error).toMatch(/connection refused/);
    expect(p.rawHtml).toBe("");
  });
});

describe("probeText", () => {
  let originalFetch: typeof globalThis.fetch;

  afterEach(() => {
    if (originalFetch) globalThis.fetch = originalFetch;
  });

  it("returns content+status on 200", async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response("User-agent: *\nAllow: /", { status: 200 }),
    ) as unknown as typeof globalThis.fetch;

    const r = await probeText("https://example.com/robots.txt");
    expect(r?.status).toBe(200);
    expect(r?.content).toMatch(/User-agent:/);
  });

  it("returns undefined on network failure", async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      throw new Error("net down");
    }) as unknown as typeof globalThis.fetch;
    const r = await probeText("https://example.com/robots.txt");
    expect(r).toBeUndefined();
  });

  it("returns a result on 404 (caller decides what 'not found' means)", async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () => new Response("Not Found", { status: 404 }),
    ) as unknown as typeof globalThis.fetch;
    const r = await probeText("https://example.com/llms.txt");
    expect(r?.status).toBe(404);
  });
});
