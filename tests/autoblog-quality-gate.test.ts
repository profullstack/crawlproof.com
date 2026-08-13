import { describe, it, expect } from "vitest";
import {
  DEFAULT_MAX_SLOP_SCORE,
  runQualityGate,
  type PriorBody,
} from "@/lib/lx/qualityGate";
import {
  buildRepairPrompt,
  collectLinkViolations,
} from "@/lib/lx/articleGen";
import { buildArticleJsonLd } from "@/lib/lx/webhookDeliver";

/**
 * A body in the shape the autoblog actually emits: long, with a table, code,
 * and concrete numbers — the signals that keep it out of "no first-party
 * evidence". Padding sentences vary so the shingler does not see repetition
 * within a single document.
 */
function goodBody(topic: string, seed = 0): string {
  const paras: string[] = [];
  for (let i = 0; i < 60; i++) {
    const n = seed * 1000 + i;
    paras.push(
      `<p>Section ${n} of the ${topic} rollout measured ${n % 97} failed requests against a ${n % 43} second budget, which changed how the ${topic} team sequenced their ${n % 17} remaining migrations before the ${2000 + (n % 26)} cutover deadline.</p>`,
    );
  }
  return [
    `<h2>Why ${topic} breaks in production</h2>`,
    ...paras,
    "<table><tr><th>Approach</th><th>Latency</th></tr><tr><td>Batched</td><td>6ms</td></tr></table>",
    "<pre><code>npx ctl apply --staged</code></pre>",
    '<blockquote>Practical rule: measure before you shard.</blockquote>',
  ].join("\n");
}

const BASE = {
  title: "How teams actually run staged migrations",
  metaDescription:
    "A practical look at what breaks when teams sequence database migrations badly, and the workflow that fixes it.",
};

describe("runQualityGate", () => {
  it("passes a substantive, unique article", () => {
    const result = runQualityGate({ ...BASE, html: goodBody("migration") });
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.score).toBeLessThanOrEqual(DEFAULT_MAX_SLOP_SCORE);
  });

  it("reports the word count it measured", () => {
    const result = runQualityGate({ ...BASE, html: goodBody("migration") });
    expect(result.metrics.wordCount).toBeGreaterThan(500);
  });

  it("rejects filler phrasing and explains the fix", () => {
    const filler = [
      "<p>In today's fast-paced world, it is important to note that we must delve into",
      "the ever-evolving digital landscape. At the end of the day, this is a game changer",
      "that will revolutionize the way you unlock the potential of your business and",
      "take your business to the next level with a robust solution. In conclusion, look no",
      "further — let's dive in and navigate the complexities of a seamless integration.</p>",
    ].join(" ");
    const result = runQualityGate({ ...BASE, html: goodBody("migration") + filler });

    expect(result.ok).toBe(false);
    expect(result.violations.join(" ")).toMatch(/filler/i);
    expect(result.issues.map((i) => i.key)).toContain("content.filler");
  });

  it("rejects a draft that repeats an existing post on the same blog", () => {
    const shared = goodBody("migration");
    const priors: PriorBody[] = [{ slug: "staged-migrations-guide", body: shared }];
    const result = runQualityGate({ ...BASE, html: shared, priorBodies: priors });

    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.key)).toContain("content.near_duplicate");
    // The violation must name the offending post so the repair pass can steer
    // away from it, not just say "too similar".
    expect(result.violations.join(" ")).toContain("staged-migrations-guide");
  });

  it("accepts a draft that shares a topic but not its text", () => {
    const priors: PriorBody[] = [
      { slug: "older-post", body: goodBody("caching", 7) },
    ];
    const result = runQualityGate({
      ...BASE,
      html: goodBody("migration", 1),
      priorBodies: priors,
    });
    expect(result.violations).toEqual([]);
  });

  it("flags a thin draft the receiver would reject on word count", () => {
    const result = runQualityGate({
      ...BASE,
      html: "<p>Short post about migrations that says almost nothing at all.</p>",
    });
    expect(result.ok).toBe(false);
    expect(result.violations.join(" ")).toMatch(/word count|Thin/i);
  });

  it("ignores host-template concerns that are not the article's fault", () => {
    // No viewport meta, a deprecated <center>, and an inline style — all
    // properties of whatever page wraps our body, not of the body itself.
    const result = runQualityGate({
      ...BASE,
      html: `<center style="color:red">${goodBody("migration")}</center>`,
    });
    expect(result.issues.map((i) => i.key)).not.toContain("code.deprecated_tags");
    expect(result.issues.map((i) => i.key)).not.toContain("design.no_viewport");
  });

  it("does not count the table of contents against link density", () => {
    // A 40-entry TOC of in-page anchors must not read as link spam.
    const toc = Array.from(
      { length: 40 },
      (_, i) => `<a href="#section-${i}">Section ${i}</a>`,
    ).join(" ");
    const result = runQualityGate({ ...BASE, html: toc + goodBody("migration") });
    expect(result.metrics.linkCount).toBe(0);
    expect(result.violations).toEqual([]);
  });
});

describe("collectLinkViolations", () => {
  const article = {
    markdown_body: "Body text linking to [a page](https://x.test/a) and nothing else.",
    used_internal_link_urls: ["https://x.test/a", "https://x.test/missing"],
    used_exchange_link_urls: ["https://partner.test/p"],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  it("names URLs claimed but not placed", () => {
    const v = collectLinkViolations(article, new Set(["https://partner.test/p"]));
    expect(v.join(" ")).toContain("https://x.test/missing");
    expect(v.join(" ")).not.toContain("https://x.test/a ");
  });

  it("rejects exchange URLs that were never offered", () => {
    const v = collectLinkViolations(article, new Set());
    expect(v.join(" ")).toContain("not in the partner-blog candidate list");
  });

  it("returns nothing when every claimed link is present", () => {
    const clean = {
      markdown_body: "Text with [a](https://x.test/a).",
      used_internal_link_urls: ["https://x.test/a"],
      used_exchange_link_urls: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    expect(collectLinkViolations(clean, new Set())).toEqual([]);
  });
});

describe("buildRepairPrompt", () => {
  it("keeps the original brief and appends a numbered fix list", () => {
    const out = buildRepairPrompt("ORIGINAL BRIEF", ["fix one", "fix two"]);
    expect(out).toContain("ORIGINAL BRIEF");
    expect(out).toContain("1. fix one");
    expect(out).toContain("2. fix two");
  });
});

describe("buildArticleJsonLd", () => {
  const input = {
    url: "https://blog.test/posts/staged-migrations",
    title: "Staged migrations",
    description: "What breaks and why.",
    imageUrl: "https://cdn.test/hero.png",
    publishedAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-09T10:00:00.000Z",
    authorName: "Dana Ruiz",
    authorUrl: "https://blog.test/authors/dana",
    publisherName: "blog.test",
    tags: ["migrations", "databases"],
  };

  it("emits a Person byline with both dates", () => {
    const html = buildArticleJsonLd(input);
    const json = JSON.parse(html.replace(/^<script[^>]*>|<\/script>$/g, ""));
    expect(json["@type"]).toBe("BlogPosting");
    expect(json.author).toMatchObject({ "@type": "Person", name: "Dana Ruiz" });
    expect(json.datePublished).toBe("2026-08-01T10:00:00.000Z");
    expect(json.dateModified).toBe("2026-08-09T10:00:00.000Z");
  });

  it("falls back to an Organization byline when no author is configured", () => {
    const html = buildArticleJsonLd({ ...input, authorName: null, authorUrl: null });
    const json = JSON.parse(html.replace(/^<script[^>]*>|<\/script>$/g, ""));
    expect(json.author).toEqual({ "@type": "Organization", name: "blog.test" });
  });

  it("escapes < so a title cannot close the script tag", () => {
    const html = buildArticleJsonLd({ ...input, title: "</script><img onerror=x>" });
    expect(html).not.toContain("</script><img");
    expect(html.match(/<\/script>/g)).toHaveLength(1);
  });
});
