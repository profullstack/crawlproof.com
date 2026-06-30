import { fetchPage, probeText } from "./fetch";

// Shared pre-fetched-context builder. Used by every LLM engine that
// doesn't have its own agentic web fetch loop (now: Claude, Qwen, Kimi,
// Gemini, DeepSeek, Z.AI, Perplexity). One round of parallel fetches,
// passed to the model as a single bundle — collapses what used to be
// 10+ agentic round trips into one API call.

const PAGE_LIMIT_BYTES = 60_000;
const PRIORITY_PATHS = [
  "/about",
  "/pricing",
  "/blog",
  "/docs",
  "/contact",
  "/team",
  "/customers",
  "/security",
];

function trim(s: string | undefined | null, max = PAGE_LIMIT_BYTES): string {
  if (!s) return "(missing)";
  return s.length > max ? s.slice(0, max) + "\n…(truncated)…" : s;
}

export async function buildSiteContext(targetUrl: string): Promise<string> {
  const u = new URL(targetUrl);
  const origin = u.origin;
  const [home, robots, sitemap, llms, skill] = await Promise.all([
    fetchPage(targetUrl),
    probeText(`${origin}/robots.txt`),
    probeText(`${origin}/sitemap.xml`),
    probeText(`${origin}/llms.txt`),
    probeText(`${origin}/skill.md`),
  ]);

  // Discover up to 4 priority linked pages from the homepage.
  const linked: { url: string; rawHtml: string }[] = [];
  if (home.rawHtml) {
    const candidates = PRIORITY_PATHS.map((p) => new URL(p, origin).toString())
      .filter((href) => home.rawHtml.toLowerCase().includes(new URL(href).pathname))
      .slice(0, 4);
    const fetched = await Promise.all(candidates.map((c) => fetchPage(c)));
    for (const f of fetched) if (f.status === 200 && f.rawHtml) linked.push(f);
  }

  return [
    `Target: ${targetUrl}`,
    ``,
    `=== Homepage (HTTP ${home.status}, ${home.bytes} bytes) ===`,
    trim(home.rawHtml),
    ``,
    `=== /robots.txt (${robots?.status ?? "n/a"}) ===`,
    trim(robots?.content, 6000),
    ``,
    `=== /sitemap.xml (${sitemap?.status ?? "n/a"}) ===`,
    trim(sitemap?.content, 8000),
    ``,
    `=== /llms.txt (${llms?.status ?? "n/a"}) ===`,
    trim(llms?.content, 4000),
    ``,
    `=== /skill.md (${skill?.status ?? "n/a"}) ===`,
    trim(skill?.content, 3000),
    ``,
    ...linked.flatMap((p) => [
      `=== Linked page ${p.url} ===`,
      trim(p.rawHtml, 20000),
      ``,
    ]),
  ].join("\n");
}
