// The insertion block writes other people's text into a customer's page.
//
// Most of what follows is injection and link-safety, because that is what this
// module actually risks. The titles come from RSS feeds crawled off the open
// web; the fact that they reach us via our own directory does not make them
// ours, and the page they land on belongs to somebody paying us.

import { describe, expect, it } from "vitest";
import {
  adInsertionOffset,
  adUnitHtml,
  escapeHtml,
  isSafeHref,
  networkLinksHtml,
  placeAdInArticle,
  type NetworkLink,
} from "@/lib/lx/networkBlock";
import { itemEntries } from "@/lib/lx/feedTopics";

describe("escapeHtml", () => {
  it("neutralises a script tag in a feed title", () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
  });

  it("escapes the ampersand first so nothing is double-escaped", () => {
    // "&lt;" must not become "&amp;lt;" — which is what a naive ordering does.
    expect(escapeHtml("<")).toBe("&lt;");
    expect(escapeHtml("&")).toBe("&amp;");
    expect(escapeHtml("&<")).toBe("&amp;&lt;");
  });

  it("escapes both quote characters, since these land in attributes", () => {
    expect(escapeHtml(`" onload="x`)).toBe("&quot; onload=&quot;x");
    expect(escapeHtml("' onload='x")).toBe("&#39; onload=&#39;x");
  });
});

describe("isSafeHref", () => {
  it.each(["javascript:alert(1)", "data:text/html,<script>", "vbscript:msgbox", "file:///etc/passwd"])(
    "rejects %j",
    (href) => expect(isSafeHref(href)).toBe(false),
  );

  it.each(["https://example.com/post", "http://example.com/post"])(
    "allows %j",
    (href) => expect(isSafeHref(href)).toBe(true),
  );

  it("rejects a relative link rather than emitting a broken anchor", () => {
    expect(isSafeHref("/relative/path")).toBe(false);
  });
});

describe("networkLinksHtml", () => {
  const links: NetworkLink[] = [
    { title: "Partner post", url: "https://partner.example/a", source: "partner" },
    { title: "Directory post", url: "https://stranger.example/b", source: "directory" },
  ];

  it("follows partner links and nofollows directory ones", () => {
    const html = networkLinksHtml(links);
    // The partner opted into an exchange; the stranger did not, and passing
    // them ranking signal would be spending someone else's reputation.
    expect(html).toMatch(/href="https:\/\/partner\.example\/a" rel="noopener"/);
    expect(html).toMatch(/href="https:\/\/stranger\.example\/b" rel="nofollow ugc noopener"/);
  });

  it("drops an unsafe link instead of rendering the whole block", () => {
    const html = networkLinksHtml([
      ...links,
      { title: "Bad", url: "javascript:alert(1)", source: "directory" },
    ]);
    expect(html).not.toContain("javascript:");
    expect(html).toContain("partner.example");
  });

  it("escapes a hostile title", () => {
    const html = networkLinksHtml([
      {
        title: '</a><script>alert(document.cookie)</script>',
        url: "https://example.com/x",
        source: "directory",
      },
    ]);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("returns nothing at all when every link was unsafe", () => {
    // An empty <ul> under a heading reads as a broken feature.
    expect(networkLinksHtml([{ title: "x", url: "javascript:1", source: "directory" }])).toBe("");
  });

  it("returns nothing for an empty list", () => {
    expect(networkLinksHtml([])).toBe("");
  });
});

describe("adUnitHtml", () => {
  it("carries the slot on the element so ad.js can fill it", () => {
    const html = adUnitHtml("slot-123", "https://crawlproof.com");
    expect(html).toContain('data-cp-ad data-slot="slot-123"');
    expect(html).toContain('src="https://crawlproof.com/ad.js"');
  });

  it("does not double the slash when the origin has a trailing one", () => {
    expect(adUnitHtml("s", "https://crawlproof.com/")).toContain("https://crawlproof.com/ad.js");
  });
});

describe("placeAdInArticle", () => {
  const AD = '<div data-cp-ad data-slot="s"></div>';

  it("puts the ad at the end of the introduction, before the first h2", () => {
    const html = "<p>One.</p>\n<p>Two.</p>\n<h2>First section</h2>\n<p>Body.</p>";
    const out = placeAdInArticle(html, AD);
    expect(out.indexOf(AD)).toBeGreaterThan(out.indexOf("Two."));
    expect(out.indexOf(AD)).toBeLessThan(out.indexOf("<h2>"));
  });

  it("never puts the ad last, where it would sit on the site footer", () => {
    const html = "<p>Intro.</p><h2>A</h2><p>a</p><h2>B</h2><p>b</p>";
    expect(placeAdInArticle(html, AD).trimEnd().endsWith("<p>b</p>")).toBe(true);
  });

  it("falls back to after the first paragraph when the article has no h2", () => {
    const html = "<p>First.</p><p>Second.</p><p>Third.</p>";
    expect(placeAdInArticle(html, AD)).toBe(`<p>First.</p>\n${AD}\n<p>Second.</p><p>Third.</p>`);
  });

  it("goes at the top when there is no top-level paragraph at all", () => {
    expect(placeAdInArticle("<ul><li><p>x</p></li></ul>", AD)).toBe(`${AD}\n<ul><li><p>x</p></li></ul>`);
  });

  it("does not split a list, quote or table", () => {
    const html = "<blockquote><p>quoted</p><h2>not here</h2></blockquote><p>Intro.</p><h2>Here</h2>";
    const out = placeAdInArticle(html, AD);
    expect(out.indexOf(AD)).toBeGreaterThan(out.indexOf("</blockquote>"));
    expect(out.indexOf(AD)).toBe(out.indexOf("<h2>Here") - AD.length - 1);
  });

  it("ignores markup-looking text inside scripts and comments", () => {
    const html = '<script type="application/ld+json">{"x":"</p><h2>"}</script><!-- <p>no</p> --><p>Intro.</p><h2>S</h2>';
    expect(adInsertionOffset(html)).toBe(html.indexOf("<h2>S"));
  });

  it("is a no-op without an ad", () => {
    expect(placeAdInArticle("<p>x</p>", "")).toBe("<p>x</p>");
  });
});

describe("itemEntries", () => {
  const feed = `<rss><channel><title>topic — RSS Amplifier</title>
    <item><title>A perfectly ordinary post about build systems</title><link>https://good.example/1</link></item>
    <item><category>Sponsored</category><title>Our own advertisement, laundered as editorial</title><link>https://ad.example/2</link></item>
    <item><title>Another post that is long enough to qualify (sponsored)</title><link>https://ad.example/3</link></item>
    <item><title>Relative links must not become anchors here</title><link>/relative</link></item>
  </channel></rss>`;

  it("excludes sponsored items by category and by title suffix", () => {
    const titles = itemEntries(feed).map((e) => e.title);
    expect(titles).toEqual(["A perfectly ordinary post about build systems", "Relative links must not become anchors here"]);
  });

  it("keeps an absolute link and nulls a relative one", () => {
    const entries = itemEntries(feed);
    expect(entries[0].link).toBe("https://good.example/1");
    expect(entries[1].link).toBeNull();
  });

  it("ignores the channel title", () => {
    expect(itemEntries(feed).map((e) => e.title)).not.toContain("topic — RSS Amplifier");
  });
});
