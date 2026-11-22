import { afterEach, describe, expect, it, vi } from "vitest";
import { sweepNative } from "@/lib/intent/native";

const now = new Date("2026-11-22T12:00:00Z");
const recent = Math.floor(now.getTime() / 1000) - 3600;

function respond(url: string): unknown {
  if (url.includes("hn.algolia.com"))
    return { hits: [{ objectID: "1", title: "Ask HN: anyone recommend an AEO audit tool? We have budget", created_at_i: recent }] };
  if (url.includes("api.stackexchange.com"))
    return { items: [{ item_type: "question", question_id: 2, title: "Which AEO audit tool should we use?", excerpt: "we need a tool", creation_date: recent }] };
  if (url.includes("api.github.com"))
    return { items: [{ html_url: "https://github.com/a/b/issues/3", title: "Tutorial: AEO audit", body: "", created_at: now.toISOString() }] };
  return {};
}

afterEach(() => vi.unstubAllGlobals());

describe("sweepNative", () => {
  it("searches HN, Stack Overflow and GitHub and scores the results", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(respond(url)), { status: 200 })));
    const r = await sweepNative({ terms: ["AEO audit"], keywords: ["AEO audit"], sources: ["forums", "github"], days: 7, minIntent: 1, now });
    expect(r.calls).toBe(3);
    const sources = r.hits.map((h) => h.source);
    expect(sources).toContain("hn");
    expect(sources).toContain("stackoverflow");
    expect(r.hits.find((h) => h.source === "hn")!.url).toBe("https://news.ycombinator.com/item?id=1");
  });

  it("leaves GitHub out unless the watch opts in", async () => {
    const f = vi.fn(async (url: string) => new Response(JSON.stringify(respond(url)), { status: 200 }));
    vi.stubGlobal("fetch", f);
    await sweepNative({ terms: ["x"], keywords: ["x"], days: 7, minIntent: 0, now });
    expect(f.mock.calls.some((c) => String(c[0]).includes("api.github.com"))).toBe(false);
  });

  it("respects the watch's source selection", async () => {
    const f = vi.fn(async (url: string) => new Response(JSON.stringify(respond(url)), { status: 200 }));
    vi.stubGlobal("fetch", f);
    await sweepNative({ terms: ["x"], keywords: ["x"], sources: ["github"], days: 7, minIntent: 0, now });
    expect(f.mock.calls.map((c) => String(c[0]))).toEqual([expect.stringContaining("api.github.com")]);
  });

  it("reports zero calls when every source fails, so the sweep is not charged", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })));
    const r = await sweepNative({ terms: ["x"], keywords: ["x"], days: 7, minIntent: 0, now });
    expect(r.calls).toBe(0);
    expect(r.hits).toEqual([]);
  });
});
