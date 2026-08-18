import { describe, expect, it } from "vitest";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import {
  ATTRIBUTION,
  adGuid,
  destinationHost,
  cdata,
  ctaLabel,
  feedDeviceType,
  feedFields,
  feedTitle,
  isFeedShape,
  isFeedStyle,
  isGuidMode,
  jsonFeedItem,
  labelText,
  renderAtomEntry,
  renderFeedHtml,
  renderFeedMarkdown,
  renderFeedText,
  renderRssItem,
  rfc822,
  FEED_SHAPES,
  FEED_STYLES,
  GUID_MODES,
  type FeedItemInput,
} from "@/lib/ads/feeditem";
import type { AdCreative } from "@/lib/ads/formats";

// A feed ad is spliced into a document somebody else published, and read by
// software that caches what it has already seen. Those two facts are what these
// tests are actually about: the fragment must not be able to break the host
// document, and the identity must rotate exactly as often as it claims to.

const NOW = new Date("2026-08-18T15:04:05.000Z");

const creative: AdCreative = {
  format: "feed_item",
  headline: "Ship faster with Widgets",
  body: "Deploy in one command, roll back in one more.",
  ctaText: "Try it free →",
  bgColor: "#0b0d10",
  fgColor: "#e7e9ee",
  accentColor: "#6ee7b7",
  fontFamily: "system-ui, sans-serif",
  logoUrl: "https://widgets.example/logo.png",
  imageUrl: null,
};

const input: FeedItemInput = {
  creative,
  clickUrl: "https://crawlproof.com/api/ads/click?i=imp-1&s=slot-1&c=camp-1&cr=cre-1",
  slotId: "slot-1",
  impressionId: "imp-1",
  tier: "paid",
};

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

/** Parse a fragment the way a reader would: inside a host document it did not write. */
function inRssChannel(fragment: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Host</title>${fragment}</channel></rss>`;
}

function inAtomFeed(fragment: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Host</title>${fragment}</feed>`;
}

describe("guards", () => {
  it("accepts every declared shape, style and guid mode", () => {
    for (const s of FEED_SHAPES) expect(isFeedShape(s)).toBe(true);
    for (const s of FEED_STYLES) expect(isFeedStyle(s)).toBe(true);
    for (const m of GUID_MODES) expect(isGuidMode(m)).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isFeedShape("opml")).toBe(false);
    expect(isFeedStyle("banner")).toBe(false);
    expect(isGuidMode("hourly")).toBe(false);
    expect(isFeedShape(null)).toBe(false);
  });
});

describe("the fragment cannot break the host document", () => {
  it("produces a well-formed RSS item inside a channel it did not write", () => {
    const doc = inRssChannel(renderRssItem(input, { now: NOW }));
    expect(XMLValidator.validate(doc)).toBe(true);
  });

  it("produces a well-formed Atom entry inside a feed it did not write", () => {
    const doc = inAtomFeed(renderAtomEntry(input, { now: NOW }));
    expect(XMLValidator.validate(doc)).toBe(true);
  });

  // The whole reason the renderer is restricted to core elements: a prefix the
  // publisher's root never declared makes the *entire feed* unparseable, not
  // just our item. Any dc:/media:/itunes: element here would be a live outage
  // for every subscriber of every publisher carrying the unit.
  it("emits no namespace-prefixed elements in either fragment", () => {
    const prefixed = /<\s*[A-Za-z_][\w.-]*:/;
    expect(renderRssItem(input, { now: NOW })).not.toMatch(prefixed);
    expect(renderAtomEntry(input, { now: NOW })).not.toMatch(prefixed);
  });

  it("survives copy that is itself markup", () => {
    const hostile: FeedItemInput = {
      ...input,
      creative: {
        ...creative,
        headline: 'Buy </description></item><item><title>Injected',
        body: "5 > 3 && 2 < 4, \"quoted\" & 'apostrophed'",
      },
    };
    const doc = inRssChannel(renderRssItem(hostile, { now: NOW }));
    expect(XMLValidator.validate(doc)).toBe(true);

    const parsed = parser.parse(doc);
    // One item, not two: the injected element never became an element.
    expect(Array.isArray(parsed.rss.channel.item)).toBe(false);
    expect(String(parsed.rss.channel.item.title)).toContain("Injected");
  });

  it("closes and reopens CDATA around a body containing its terminator", () => {
    const wrapped = cdata("before ]]> after");
    expect(wrapped).toBe("<![CDATA[before ]]]]><![CDATA[> after]]>");
    // And the result still parses inside a real document.
    const doc = `<r><d>${wrapped}</d></r>`;
    expect(XMLValidator.validate(doc)).toBe(true);
    expect(parser.parse(doc).r.d).toBe("before ]]> after");
  });

  it("strips the control characters XML forbids outright", () => {
    const withCtl: FeedItemInput = {
      ...input,
      creative: { ...creative, headline: "Bell\u0007and\u0000null" },
    };
    const doc = inRssChannel(renderRssItem(withCtl, { now: NOW }));
    expect(XMLValidator.validate(doc)).toBe(true);
    expect(doc).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/);
  });
});

describe("identity", () => {
  it("is stable within a day and changes across days", () => {
    const a = adGuid("daily", { slotId: "s", impressionId: "i1", now: NOW });
    const b = adGuid("daily", {
      slotId: "s",
      impressionId: "i2", // a different fill, same day
      now: new Date("2026-08-18T23:59:59.000Z"),
    });
    const c = adGuid("daily", {
      slotId: "s",
      impressionId: "i3",
      now: new Date("2026-08-19T00:00:01.000Z"),
    });

    expect(a.guid).toBe(b.guid);
    expect(a.guid).not.toBe(c.guid);
    // Dated to the period, so the item does not keep jumping up the reader's
    // sort order every time the publisher rebuilds.
    expect(a.published.toISOString()).toBe("2026-08-18T00:00:00.000Z");
  });

  it("is stable within a week, and weeks start on Monday", () => {
    // 2026-08-18 is a Tuesday; the Monday before it is the 17th.
    const tue = adGuid("weekly", { slotId: "s", impressionId: "i", now: NOW });
    const sun = adGuid("weekly", {
      slotId: "s",
      impressionId: "i",
      now: new Date("2026-08-23T23:00:00.000Z"), // the Sunday of the same week
    });
    const mon = adGuid("weekly", {
      slotId: "s",
      impressionId: "i",
      now: new Date("2026-08-24T00:00:00.000Z"), // the next Monday
    });

    expect(tue.published.toISOString()).toBe("2026-08-17T00:00:00.000Z");
    expect(sun.guid).toBe(tue.guid);
    expect(mon.guid).not.toBe(tue.guid);
  });

  it("is unique per fill under guid=fill", () => {
    const a = adGuid("fill", { slotId: "s", impressionId: "i1", now: NOW });
    const b = adGuid("fill", { slotId: "s", impressionId: "i2", now: NOW });
    expect(a.guid).not.toBe(b.guid);
  });

  it("never changes under guid=static", () => {
    const a = adGuid("static", { slotId: "s", impressionId: "i1", now: NOW });
    const b = adGuid("static", {
      slotId: "s",
      impressionId: "i2",
      now: new Date("2027-01-01T00:00:00.000Z"),
    });
    expect(a.guid).toBe(b.guid);
  });

  it("separates publishers, so one slot's ad is not another's", () => {
    const a = adGuid("daily", { slotId: "slot-a", impressionId: "i", now: NOW });
    const b = adGuid("daily", { slotId: "slot-b", impressionId: "i", now: NOW });
    expect(a.guid).not.toBe(b.guid);
  });

  // Three ads in one document must be three items, not the same item thrice.
  it("separates positions within a multi-ad request", () => {
    const seen = new Set(
      [0, 1, 2].map(
        (position) => adGuid("daily", { slotId: "s", impressionId: "i", position, now: NOW }).guid,
      ),
    );
    expect(seen.size).toBe(3);
  });

  // Position 0 must add nothing, or every existing subscriber would see the
  // whole back catalogue of ads resurface the day this shipped.
  it("leaves the single-ad identity untouched", () => {
    const withOut = adGuid("daily", { slotId: "s", impressionId: "i", now: NOW });
    const withZero = adGuid("daily", { slotId: "s", impressionId: "i", position: 0, now: NOW });
    expect(withZero.guid).toBe(withOut.guid);
  });

  it("mints an Atom-legal id", () => {
    const { guid } = adGuid("daily", { slotId: "s", impressionId: "i", now: NOW });
    // An Atom <id> must be an absolute IRI; tag: is the scheme for names that
    // are not fetchable addresses.
    expect(guid).toMatch(/^tag:crawlproof\.com,2026:/);
  });

  it("marks the guid as not a permalink", () => {
    expect(renderRssItem(input, { now: NOW })).toContain('<guid isPermaLink="false">');
  });
});

describe("disclosure", () => {
  it("is in the title, where a reader listing titles will see it", () => {
    expect(feedTitle(creative)).toBe("Ship faster with Widgets (Sponsored)");
  });

  // Leading "[Sponsored]" is the first thing the eye meets in a list of
  // headlines and reads as a spam subject-line prefix, so the item is skipped
  // before the offer is read. The label travels just as far at the end.
  it("does not lead with the label", () => {
    expect(feedTitle(creative).startsWith("[")).toBe(false);
    expect(feedTitle(creative).startsWith("Sponsored")).toBe(false);
    expect(feedTitle(creative)).toContain("Sponsored");
  });

  it("can be reworded but not removed", () => {
    expect(feedTitle(creative, "Ad")).toBe("Ship faster with Widgets (Ad)");
    expect(labelText("")).toBe("Sponsored");
    expect(labelText("   ")).toBe("Sponsored");
    expect(labelText(null)).toBe("Sponsored");
    // Brackets would let a caller forge a second label inside the first.
    expect(labelText("[not] an ad")).toBe("not an ad");
  });

  it("rides on the item as a category too", () => {
    expect(renderRssItem(input, { now: NOW })).toContain("<category>Sponsored</category>");
    expect(renderAtomEntry(input, { now: NOW })).toContain('<category term="sponsored"');
  });

  // The HTML bodies carry the attribution as a link, so they use the exact
  // string. The terminal style delegates to the ASCII renderer, whose bottom
  // border has carried its own wording ("ads by crawlproof.com") since the MOTD
  // format shipped — so what is asserted across all styles is that the network
  // is named, not that one phrasing won.
  it("attributes the network in every body style", () => {
    for (const style of FEED_STYLES) {
      expect(renderFeedHtml(creative, input.clickUrl, { style }).toLowerCase()).toContain(
        "crawlproof",
      );
      expect(renderFeedText(creative, input.clickUrl, { style }).toLowerCase()).toContain(
        "crawlproof",
      );
    }
    expect(renderFeedHtml(creative, input.clickUrl, { style: "text" })).toContain(ATTRIBUTION);
    expect(renderFeedText(creative, input.clickUrl, { style: "text" })).toContain(ATTRIBUTION);
  });
});

describe("bodies", () => {
  it("marks every link as paid, in every style", () => {
    for (const style of FEED_STYLES) {
      const html = renderFeedHtml(creative, input.clickUrl, { style });
      for (const rel of html.matchAll(/rel="([^"]*)"/g)) {
        // A syndicated paid link that is not disclosed to crawlers is the
        // textbook shape of a link scheme.
        expect(rel[1]).toContain("sponsored");
        expect(rel[1]).toContain("nofollow");
      }
      expect(html).toMatch(/rel="/);
    }
  });

  it("uses no CSS, which readers strip anyway", () => {
    for (const style of FEED_STYLES) {
      const html = renderFeedHtml(creative, input.clickUrl, { style });
      expect(html).not.toMatch(/<style/i);
      expect(html).not.toMatch(/\sstyle=/i);
      expect(html).not.toMatch(/<script/i);
      expect(html).not.toMatch(/\sclass=/i);
    }
  });

  it("renders the logo only in the card style", () => {
    expect(renderFeedHtml(creative, input.clickUrl, { style: "card" })).toContain(creative.logoUrl!);
    expect(renderFeedHtml(creative, input.clickUrl, { style: "text" })).not.toContain(
      creative.logoUrl!,
    );
  });

  // The card sits between real blog posts that each have a picture and a few
  // paragraphs; a bare line next to them reads as broken rather than restrained.
  it("leads the card with the advertiser's artwork", () => {
    const withArt = { ...creative, imageUrl: "https://widgets.example/hero.png" };
    const html = renderFeedHtml(withArt, input.clickUrl, { style: "card" });

    expect(html).toContain('src="https://widgets.example/hero.png"');
    // Width only: readers scale to their own column, and a fixed height would
    // distort every image that is not exactly the ratio we guessed.
    expect(html).toContain('width="600"');
    expect(html).not.toMatch(/<img[^>]*hero\.png[^>]*height=/);
    // The picture comes before the headline, the way the posts around it do.
    expect(html.indexOf("hero.png")).toBeLessThan(html.indexOf("<h3>"));
  });

  it("renders a card without artwork rather than a broken image", () => {
    const noArt = { ...creative, imageUrl: null };
    const html = renderFeedHtml(noArt, input.clickUrl, { style: "card" });
    expect(html).not.toContain("<img src=\"\"");
    expect(html).toContain("<h3>");
    expect(html).toContain(ATTRIBUTION);
  });

  it("names who is paying, which is what a reader actually decides on", () => {
    const html = renderFeedHtml(creative, input.clickUrl, { style: "card" });
    expect(html).toContain("widgets.example");
  });

  it("never offers our own redirector as the advertiser's identity", () => {
    // The click URL is always crawlproof.com, so it can never be the brand
    // line, and neither can artwork we host on the advertiser's behalf.
    const ours = {
      ...creative,
      logoUrl: "https://crawlproof.com/ads/house/promo.webp",
      imageUrl: null,
    };
    expect(destinationHost(input.clickUrl, ours)).toBe("");
    expect(destinationHost(input.clickUrl, creative)).toBe("widgets.example");
  });

  it("puts the same artwork in the markdown card", () => {
    const withArt = { ...creative, imageUrl: "https://widgets.example/hero.png" };
    const md = renderFeedMarkdown(withArt, input.clickUrl, { style: "card" });
    expect(md).toContain("![");
    expect(md).toContain("https://widgets.example/hero.png");
    expect(md).toContain("widgets.example");
  });

  it("does not double the arrow on copy that already has one", () => {
    expect(ctaLabel("Try it free →")).toBe("Try it free");
    expect(ctaLabel("Learn more ->")).toBe("Learn more");
    expect(ctaLabel("  ")).toBe("Learn more");
    expect(renderFeedText(creative, input.clickUrl)).not.toContain("→ →");
  });

  it("escapes Markdown punctuation so ad copy cannot reformat the page", () => {
    const md = renderFeedMarkdown(
      { ...creative, headline: "50% off *everything* [today]" },
      input.clickUrl,
    );
    expect(md).toContain("\\*everything\\*");
    expect(md).toContain("\\[today\\]");
  });

  it("percent-encodes a click URL that would end a Markdown link early", () => {
    const md = renderFeedMarkdown(creative, "https://x.example/a(b)c");
    expect(md).toContain("https://x.example/a%28b%29c");
  });

  it("keeps plain text plain", () => {
    const text = renderFeedText(creative, input.clickUrl);
    expect(text).toContain("[Sponsored] Ship faster with Widgets");
    expect(text).toContain(input.clickUrl);
    expect(text).not.toMatch(/<[a-z]/i);
  });
});

describe("json shapes", () => {
  it("builds a JSON Feed 1.1 item with the disclosure machine-readable", () => {
    const item = jsonFeedItem(input, { now: NOW }) as Record<string, unknown>;
    expect(item.id).toMatch(/^tag:crawlproof\.com,2026:/);
    expect(item.url).toBe(input.clickUrl);
    expect(item.tags).toEqual(["Sponsored"]);
    expect((item._crawlproof as Record<string, unknown>).sponsored).toBe(true);
    expect(String(item.date_published)).toBe("2026-08-18T00:00:00.000Z");
  });

  it("gives a consumer every part it might template from", () => {
    const f = feedFields(input, { now: NOW }) as Record<string, unknown>;
    for (const key of ["guid", "title", "headline", "body", "cta", "url", "publishedAt", "html", "markdown", "text"]) {
      expect(f[key], key).toBeTruthy();
    }
    // The raw headline, without the disclosure prefix baked in, so a consumer
    // that discloses its own way is not forced to string-strip ours.
    expect(f.headline).toBe("Ship faster with Widgets");
    expect(f.title).toBe("Ship faster with Widgets (Sponsored)");
    expect(f.tier).toBe("paid");
  });
});

describe("client classification", () => {
  // The bug this exists to prevent: a feed builder identifies as an HTTP
  // library, the generic tracker calls that a bot, isBotDevice sends bots to
  // the unmetered house ad, and the slot can never earn. Same trap the terminal
  // format hit.
  it("treats feed builders and readers as the audience, not as bots", () => {
    for (const ua of [
      "Feedly/1.0 (+http://www.feedly.com/fetcher.html; like FeedFetcher-Google)",
      "Inoreader/1.0 (+http://www.inoreader.com/feed-fetcher)",
      "NetNewsWire/6.1",
      "Miniflux/2.0.51",
      "curl/8.5.0",
      "node-fetch/1.0",
      "Go-http-client/2.0",
      "python-requests/2.31.0",
      "Hugo Static Site Generator",
    ]) {
      expect(feedDeviceType(ua), ua).toBe("feed");
    }
  });

  it("treats a missing user agent as a feed builder", () => {
    expect(feedDeviceType(null)).toBe("feed");
    expect(feedDeviceType("")).toBe("feed");
  });

  it("still keeps real crawlers off paid inventory", () => {
    expect(feedDeviceType("Mozilla/5.0 (compatible; Googlebot/2.1)")).toBe("bot");
    expect(feedDeviceType("AhrefsBot/7.0")).toBe("bot");
  });

  it("defers to the caller for anything it cannot place", () => {
    expect(feedDeviceType("Mozilla/5.0 (Macintosh) Safari/605.1.15")).toBeNull();
  });
});

describe("rfc822", () => {
  it("formats a pubDate the way RSS specifies", () => {
    expect(rfc822(new Date("2026-08-18T00:00:00.000Z"))).toBe("Tue, 18 Aug 2026 00:00:00 GMT");
  });
});
