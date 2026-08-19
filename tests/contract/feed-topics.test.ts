import { describe, it, expect } from "vitest";

import {
  itemTitles,
  subjectFromTopicFeeds,
  topicSlug,
} from "@/lib/lx/feedTopics";

const rss = (items: string) => `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>marketing — RSS Amplifier</title>
  ${items}
</channel></rss>`;

const item = (title: string, extra = "") =>
  `<item><title>${title}</title>${extra}</item>`;

describe("reading subjects out of a topic feed", () => {
  it("never offers one of our own ads as a subject", () => {
    // The failure this exists to prevent, and it is not hypothetical: the
    // directory's feeds now carry CrawlProof ad fills as syndication items.
    // Without this filter the cron could commission a guest post *about an
    // advertisement* and publish it on a partner's blog under our name — an ad
    // laundered into editorial. Both signals are checked because either alone
    // is a single point of failure for something that must never happen.
    const xml = rss(
      [
        item(
          "Home of the Agentic Pull Request (Sponsored)",
          "<category>Sponsored</category>",
        ),
        item("Another Paid Placement Dressed As A Post", "<category>Sponsored</category>"),
        item("A Sponsored Title With No Category Element (Sponsored)"),
        item("Why I Said Yes to a $1,000-an-Hour Coach"),
      ].join(""),
    );

    expect(itemTitles(xml)).toEqual(["Why I Said Yes to a $1,000-an-Hour Coach"]);
  });

  it("leaves the channel's own title out of the candidates", () => {
    // The topic name is a label, not a subject. It sits outside <item>, which
    // is why the parse is scoped to item blocks.
    const titles = itemTitles(rss(item("A perfectly ordinary post title here")));
    expect(titles).not.toContain("marketing — RSS Amplifier");
    expect(titles).toEqual(["A perfectly ordinary post title here"]);
  });

  it("drops titles too short to be a subject and too long to be a prompt", () => {
    const xml = rss(
      [
        item("Weeknotes"),
        item("Ok"),
        item("x".repeat(400)),
        item("A title of a perfectly reasonable length for an article"),
      ].join(""),
    );
    expect(itemTitles(xml)).toEqual([
      "A title of a perfectly reasonable length for an article",
    ]);
  });

  it("decodes what the feed escaped, so the subject reads as written", () => {
    // Titles arrive from fifty thousand publishers carrying entities. A subject
    // line reading "Don&apos;t" would be written into the article verbatim.
    const xml = rss(
      item("Don&apos;t Ship It &amp; Hope &#8212; A Checklist For Releases"),
    );
    expect(itemTitles(xml)[0]).toBe(
      "Don't Ship It & Hope — A Checklist For Releases",
    );
  });

  it("reads a CDATA title", () => {
    const xml = rss(item("<![CDATA[A title wrapped in CDATA for safety]]>"));
    expect(itemTitles(xml)).toEqual(["A title wrapped in CDATA for safety"]);
  });

  it("returns nothing for a document that is not a feed", () => {
    expect(itemTitles("<html><body>not a feed at all</body></html>")).toEqual([]);
    expect(itemTitles("")).toEqual([]);
  });
});

describe("topicSlug", () => {
  it("matches the directory's own slugging", () => {
    expect(topicSlug("Machine Learning")).toBe("machine-learning");
    expect(topicSlug("  AI & robotics  ")).toBe("ai-robotics");
    expect(topicSlug("C++")).toBe("c");
  });

  it("slugs unusable input to empty rather than to a bad URL", () => {
    // `/topics/.rss` is not a feed; the caller skips these instead of asking.
    expect(topicSlug("!!!")).toBe("");
    expect(topicSlug("")).toBe("");
  });
});

describe("picking a subject", () => {
  const ok = (body: string) =>
    ({ ok: true, text: async () => body }) as unknown as Response;

  it("returns a real post title from the first feed that has one", async () => {
    const fetchImpl = (async () =>
      ok(rss(item("How We Cut Our Build Time By Ninety Percent")))) as typeof fetch;

    const found = await subjectFromTopicFeeds(["build systems"], fetchImpl);
    expect(found?.subject).toBe("How We Cut Our Build Time By Ninety Percent");
  });

  it("moves on when a feed is empty or missing", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(String(url));
      if (seen.length === 1) return { ok: false } as Response;
      if (seen.length === 2) return ok(rss(""));
      return ok(rss(item("The third feed finally has something usable")));
    }) as unknown as typeof fetch;

    const found = await subjectFromTopicFeeds(["a", "b", "c"], fetchImpl);
    expect(found?.subject).toBe("The third feed finally has something usable");
  });

  it("returns null rather than throwing when the directory is unreachable", async () => {
    // This runs inside the publishing cron while it walks every active site. A
    // slow directory must cost one site its guest post, not the sweep.
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    expect(await subjectFromTopicFeeds(["anything"], fetchImpl)).toBeNull();
  });

  it("asks for nothing when there are no usable keywords", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return ok(rss(""));
    }) as unknown as typeof fetch;

    expect(await subjectFromTopicFeeds(["!!!", ""], fetchImpl)).toBeNull();
    expect(called).toBe(false);
  });

  it("does not ask the same feed twice for a duplicated keyword", async () => {
    const asked: string[] = [];
    const fetchImpl = (async (url: string) => {
      asked.push(String(url));
      return ok(rss(""));
    }) as unknown as typeof fetch;

    await subjectFromTopicFeeds(["Design", "design", "  DESIGN  "], fetchImpl);
    expect(asked).toHaveLength(1);
  });
});
