import type { CrawlContext, Finding } from "../types";

// Parse robots.txt into per-UA disallow lists.
function parseRobots(text: string): Record<string, { allow: string[]; disallow: string[] }> {
  const groups: Record<string, { allow: string[]; disallow: string[] }> = {};
  let current: string[] = [];
  for (const lineRaw of text.split(/\r?\n/)) {
    const line = lineRaw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const [k, ...rest] = line.split(":");
    if (!k || rest.length === 0) continue;
    const key = k.trim().toLowerCase();
    const value = rest.join(":").trim();
    if (key === "user-agent") {
      current = [value];
      groups[value] ??= { allow: [], disallow: [] };
    } else if (key === "disallow") {
      for (const ua of current) (groups[ua] ??= { allow: [], disallow: [] }).disallow.push(value);
    } else if (key === "allow") {
      for (const ua of current) (groups[ua] ??= { allow: [], disallow: [] }).allow.push(value);
    }
  }
  return groups;
}

// Bots we care about for AEO.
const AI_BOTS = [
  "GPTBot",
  "ClaudeBot",
  "PerplexityBot",
  "Google-Extended",
  "OAI-SearchBot",
  "Applebot-Extended",
  "CCBot",
];

export function checkRobotsAndSitemap(ctx: CrawlContext): Finding[] {
  const out: Finding[] = [];
  const robots = ctx.wellKnown.robots;
  const sitemap = ctx.wellKnown.sitemap;

  if (!robots || robots.status >= 400) {
    out.push({
      section: "robots.txt and sitemap.xml Audit",
      check_key: "robots.exists",
      status: "warn",
      title: "robots.txt not found",
      detail:
        "No /robots.txt was reachable. Add one explicitly — silence is read differently by different crawlers, and you lose the chance to control AI bots.",
      priority: 2,
    });
  } else {
    out.push({
      section: "robots.txt and sitemap.xml Audit",
      check_key: "robots.exists",
      status: "pass",
      title: "robots.txt present",
      detail: `${robots.content.length} chars`,
      evidence: { snippet: robots.content.slice(0, 800) },
      priority: 5,
    });

    const groups = parseRobots(robots.content);
    const sitemaps = (robots.content.match(/^\s*Sitemap:\s*(.+)$/gim) ?? []).map((l) =>
      l.split(":").slice(1).join(":").trim(),
    );
    if (sitemaps.length === 0) {
      out.push({
        section: "robots.txt and sitemap.xml Audit",
        check_key: "robots.sitemap_ref",
        status: "warn",
        title: "robots.txt does not reference a Sitemap",
        detail: "Add `Sitemap: https://yoursite.com/sitemap.xml` to robots.txt.",
        priority: 3,
      });
    } else {
      out.push({
        section: "robots.txt and sitemap.xml Audit",
        check_key: "robots.sitemap_ref",
        status: "pass",
        title: "robots.txt references sitemap(s)",
        evidence: { sitemaps },
        priority: 5,
      });
    }

    // AI bot accessibility
    for (const bot of AI_BOTS) {
      const g = groups[bot];
      const star = groups["*"];
      const blockedByStar = star?.disallow.includes("/") ?? false;
      const blockedByBot = g?.disallow.includes("/") ?? false;
      if (blockedByBot) {
        out.push({
          section: "LLM / AI Crawler Accessibility",
          check_key: `aibot.${bot}`,
          status: "fail",
          title: `${bot} is blocked`,
          detail: `robots.txt disallows ${bot} from /. This bot cannot index your site.`,
          priority: 1,
        });
      } else if (!g && blockedByStar) {
        out.push({
          section: "LLM / AI Crawler Accessibility",
          check_key: `aibot.${bot}`,
          status: "fail",
          title: `${bot} blocked via wildcard`,
          detail: `User-agent: * is disallowed from / and no explicit rule for ${bot} overrides it.`,
          priority: 1,
        });
      } else if (g) {
        out.push({
          section: "LLM / AI Crawler Accessibility",
          check_key: `aibot.${bot}`,
          status: "pass",
          title: `${bot} has explicit rules`,
          detail: "An explicit User-agent block exists. Make sure it allows the paths you want indexed.",
          priority: 5,
        });
      } else {
        out.push({
          section: "LLM / AI Crawler Accessibility",
          check_key: `aibot.${bot}`,
          status: "warn",
          title: `${bot} not explicitly addressed`,
          detail: `No User-agent: ${bot} block in robots.txt. We recommend explicit Allow rules so crawlers don't fall back to defaults.`,
          priority: 3,
        });
      }
    }
  }

  if (!sitemap || sitemap.status >= 400) {
    out.push({
      section: "robots.txt and sitemap.xml Audit",
      check_key: "sitemap.exists",
      status: "fail",
      title: "sitemap.xml not found",
      detail: "Add /sitemap.xml — required for reliable AI/SERP discovery.",
      priority: 1,
    });
  } else {
    const urlCount = (sitemap.content.match(/<loc>/g) ?? []).length;
    out.push({
      section: "robots.txt and sitemap.xml Audit",
      check_key: "sitemap.exists",
      status: "pass",
      title: `sitemap.xml present (${urlCount} URLs)`,
      evidence: { urlCount, snippet: sitemap.content.slice(0, 800) },
      priority: 5,
    });
    if (urlCount === 0) {
      out.push({
        section: "robots.txt and sitemap.xml Audit",
        check_key: "sitemap.empty",
        status: "warn",
        title: "Sitemap is empty",
        detail: "No <loc> entries found. Sitemap should list canonical URLs.",
        priority: 2,
      });
    }
  }

  // llms.txt / skill.md
  const llms = ctx.wellKnown.llmsTxt;
  out.push({
    section: "LLM / AI Crawler Accessibility",
    check_key: "llms_txt",
    status: llms && llms.status === 200 ? "pass" : "warn",
    title: llms && llms.status === 200 ? "llms.txt present" : "llms.txt missing",
    detail:
      llms && llms.status === 200
        ? `${llms.content.length} chars`
        : "Add /llms.txt — a concise, link-rich summary that helps LLMs orient on your site.",
    evidence: llms?.status === 200 ? { snippet: llms.content.slice(0, 400) } : undefined,
    priority: llms?.status === 200 ? 5 : 2,
  });

  const skill = ctx.wellKnown.skillMd;
  out.push({
    section: "LLM / AI Crawler Accessibility",
    check_key: "skill_md",
    status: skill && skill.status === 200 ? "pass" : "warn",
    title: skill && skill.status === 200 ? "skill.md present" : "skill.md missing",
    detail:
      skill && skill.status === 200
        ? undefined
        : "Add /skill.md describing what your site lets agents do — speeds up agent task routing.",
    priority: skill?.status === 200 ? 5 : 3,
  });

  const ai = ctx.wellKnown.aiPlugin;
  if (ai && ai.status === 200) {
    out.push({
      section: "LLM / AI Crawler Accessibility",
      check_key: "ai_plugin_json",
      status: "pass",
      title: "/.well-known/ai-plugin.json present",
      priority: 5,
    });
  }

  const sec = ctx.wellKnown.securityTxt;
  out.push({
    section: "LLM / AI Crawler Accessibility",
    check_key: "security_txt",
    status: sec && sec.status === 200 ? "pass" : "warn",
    title: sec && sec.status === 200
      ? "/.well-known/security.txt present"
      : "/.well-known/security.txt missing",
    detail: sec && sec.status === 200
      ? "Security contact published — builds trust with crawlers and security researchers."
      : "Publish a /.well-known/security.txt with at least a Contact: line. Crawlers and security researchers expect it; AI systems use it as a trust signal.",
    priority: sec && sec.status === 200 ? 5 : 3,
  });

  return out;
}
