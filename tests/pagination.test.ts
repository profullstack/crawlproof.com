import { describe, it, expect } from "vitest";
import { findNextPageUrl, nextClickSelector } from "@/lib/outreach/pagination";

const BASE = "https://dir.test/browse";

describe("findNextPageUrl", () => {
  it("prefers rel=next, which is the site saying so outright", () => {
    const html = `<link rel="next" href="/browse?page=2"><a href="/browse?page=9">Last</a>`;
    expect(findNextPageUrl(html, BASE)).toBe("https://dir.test/browse?page=2");
  });

  it("reads rel=next with the attributes in either order", () => {
    const html = `<a href="/browse?page=3" rel="next">go</a>`;
    expect(findNextPageUrl(html, BASE)).toBe("https://dir.test/browse?page=3");
  });

  it("follows a link whose text is a next control", () => {
    const html = `<a href="/browse?page=2">Next</a>`;
    expect(findNextPageUrl(html, BASE)).toBe("https://dir.test/browse?page=2");
  });

  it("follows an arrow-only control via aria-label", () => {
    // The visible text is an icon, so the label is the only signal.
    const html = `<a href="/browse?page=4" aria-label="Next page"><svg/></a>`;
    expect(findNextPageUrl(html, BASE)).toBe("https://dir.test/browse?page=4");
  });

  it("does not treat prose starting with 'next' as a control", () => {
    // "Next steps" is a heading link, not pagination. Visible text is
    // matched whole for exactly this reason.
    expect(findNextPageUrl(`<a href="/guide">Next steps</a>`, BASE)).toBeNull();
  });

  it("refuses a disabled next control", () => {
    // A disabled arrow means this is the last page; following it loops.
    const html = `<a href="/browse?page=2" aria-disabled="true">Next</a>`;
    expect(findNextPageUrl(html, BASE)).toBeNull();
  });

  it("ignores an anchor to a fragment", () => {
    expect(findNextPageUrl(`<a href="#next">Next</a>`, BASE)).toBeNull();
  });

  it("never returns the page it was given", () => {
    const html = `<a href="/browse" rel="next">Next</a>`;
    expect(findNextPageUrl(html, BASE)).toBeNull();
  });

  it("increments a page parameter the URL already carries", () => {
    expect(findNextPageUrl("<p>no links</p>", "https://dir.test/browse?page=2")).toBe(
      "https://dir.test/browse?page=3",
    );
  });

  it("does not invent a page parameter that was never there", () => {
    // Fabricating ?page=2 asks for a page that may not exist, on every site.
    expect(findNextPageUrl("<p>no links</p>", BASE)).toBeNull();
  });

  it("leaves row-offset parameters alone", () => {
    // offset counts rows, and the page size is not knowable from here —
    // incrementing by one would re-fetch almost the same list.
    expect(findNextPageUrl("<p>x</p>", "https://dir.test/browse?offset=20")).toBeNull();
  });

  it("preserves the other query parameters when advancing", () => {
    const next = findNextPageUrl("<p>x</p>", "https://dir.test/browse?skills=abc&page=1");
    expect(next).toContain("skills=abc");
    expect(next).toContain("page=2");
  });

  it("resolves a relative href against the current page", () => {
    expect(findNextPageUrl(`<a href="page/2" rel="next">Next</a>`, "https://dir.test/browse/")).toBe(
      "https://dir.test/browse/page/2",
    );
  });

  it("refuses a non-http scheme", () => {
    expect(findNextPageUrl(`<a href="javascript:void(0)" rel="next">Next</a>`, BASE)).toBeNull();
  });
});

describe("nextClickSelector", () => {
  it("offers a selector when the control has no href", () => {
    expect(nextClickSelector(`<button>Load more</button>`)).toBeTruthy();
  });

  it("offers nothing when there is no such control", () => {
    // Clicking needs a live browser per page, so it is only worth proposing
    // when the page really has no followable link.
    expect(nextClickSelector(`<a href="/browse?page=2">Next</a>`)).toBeNull();
  });
});

describe("walking a site that ignores its page parameter", () => {
  it("still offers a next URL — the guard against looping is the caller's", () => {
    // findNextPageUrl cannot know whether ?page=2 is real; only fetching it
    // and seeing nothing new can. discoverFromSeed stops when a page adds no
    // entries, which is what keeps a site that ignores the parameter from
    // being walked to the page cap.
    expect(findNextPageUrl("<p>no pager</p>", "https://dir.test/browse?page=1")).toBe(
      "https://dir.test/browse?page=2",
    );
  });
});
