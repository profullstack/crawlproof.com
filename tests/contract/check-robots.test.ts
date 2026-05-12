import { describe, it, expect } from "vitest";
import { checkRobotsAndSitemap } from "@/lib/audit/checks/robots";
import type { CrawlContext } from "@/lib/audit/types";

function ctx(opts: {
  robots?: string;
  sitemap?: string;
  llms?: string;
  skill?: string;
}): CrawlContext {
  return {
    target: "https://example.com/",
    origin: "https://example.com",
    host: "example.com",
    pages: {},
    wellKnown: {
      robots: opts.robots !== undefined ? { content: opts.robots, status: 200 } : undefined,
      sitemap: opts.sitemap !== undefined ? { content: opts.sitemap, status: 200 } : undefined,
      llmsTxt: opts.llms !== undefined ? { content: opts.llms, status: 200 } : undefined,
      skillMd: opts.skill !== undefined ? { content: opts.skill, status: 200 } : undefined,
    },
    findings: [],
  };
}
const find = (arr: ReturnType<typeof checkRobotsAndSitemap>, key: string) =>
  arr.find((f) => f.check_key === key);

describe("checkRobotsAndSitemap", () => {
  it("warns when robots.txt is missing", () => {
    const out = checkRobotsAndSitemap(ctx({ sitemap: "<urlset></urlset>" }));
    expect(find(out, "robots.exists")?.status).toBe("warn");
  });

  it("fails when sitemap.xml is missing", () => {
    const out = checkRobotsAndSitemap(ctx({ robots: "User-agent: *\nAllow: /" }));
    expect(find(out, "sitemap.exists")?.status).toBe("fail");
  });

  it("flags a star-disallow as fail for AI bots without explicit rules", () => {
    const out = checkRobotsAndSitemap(
      ctx({ robots: "User-agent: *\nDisallow: /", sitemap: "<urlset></urlset>" }),
    );
    expect(find(out, "aibot.GPTBot")?.status).toBe("fail");
    expect(find(out, "aibot.ClaudeBot")?.status).toBe("fail");
    expect(find(out, "aibot.PerplexityBot")?.status).toBe("fail");
  });

  it("explicit Disallow:/ on a specific AI bot is a fail for that bot", () => {
    const robots = "User-agent: GPTBot\nDisallow: /";
    const out = checkRobotsAndSitemap(ctx({ robots, sitemap: "<urlset></urlset>" }));
    expect(find(out, "aibot.GPTBot")?.status).toBe("fail");
  });

  it("explicit allow block for a bot passes", () => {
    const robots = "User-agent: GPTBot\nAllow: /\n\nUser-agent: ClaudeBot\nAllow: /";
    const out = checkRobotsAndSitemap(ctx({ robots, sitemap: "<urlset></urlset>" }));
    expect(find(out, "aibot.GPTBot")?.status).toBe("pass");
    expect(find(out, "aibot.ClaudeBot")?.status).toBe("pass");
    // Others without explicit rules are warn (not addressed)
    expect(find(out, "aibot.PerplexityBot")?.status).toBe("warn");
  });

  it("flags missing llms.txt and skill.md as warn", () => {
    const out = checkRobotsAndSitemap(
      ctx({ robots: "User-agent: *\nAllow: /", sitemap: "<urlset></urlset>" }),
    );
    expect(find(out, "llms_txt")?.status).toBe("warn");
    expect(find(out, "skill_md")?.status).toBe("warn");
  });

  it("passes llms.txt and skill.md when present", () => {
    const out = checkRobotsAndSitemap(
      ctx({
        robots: "User-agent: *\nAllow: /",
        sitemap: "<urlset></urlset>",
        llms: "# Example\n\n> short summary",
        skill: "---\nname: example\n---",
      }),
    );
    expect(find(out, "llms_txt")?.status).toBe("pass");
    expect(find(out, "skill_md")?.status).toBe("pass");
  });

  it("warns when robots.txt has no Sitemap directive", () => {
    const out = checkRobotsAndSitemap(
      ctx({ robots: "User-agent: *\nAllow: /", sitemap: "<urlset></urlset>" }),
    );
    expect(find(out, "robots.sitemap_ref")?.status).toBe("warn");
  });

  it("passes when robots.txt references a sitemap URL", () => {
    const robots = "User-agent: *\nAllow: /\nSitemap: https://example.com/sitemap.xml";
    const out = checkRobotsAndSitemap(ctx({ robots, sitemap: "<urlset></urlset>" }));
    expect(find(out, "robots.sitemap_ref")?.status).toBe("pass");
  });
});
