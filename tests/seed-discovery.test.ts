import { describe, it, expect } from "vitest";
import { extractSameHostLinks, extractOutboundProspects } from "@/lib/outreach/discover";

// Shaped like a platform directory: every listing links to a profile on the
// platform's own domain, alongside the usual nav furniture.
const DIRECTORY_HTML = `
<html><body>
  <nav>
    <a href="/">Home</a>
    <a href="/search?sort_by=followers">Search</a>
    <a href="/login">Log in</a>
    <a href="/about">About</a>
    <a href="/pricing">Pricing</a>
  </nav>
  <ul>
    <li><a href="/janedoe">Jane Doe</a></li>
    <li><a href="/john-smith">John Smith</a></li>
    <li><a href="https://www.platform.test/kim_lee">Kim Lee</a></li>
    <li><a href="/studios/acme">Acme Studios</a></li>
    <li><a href="/janedoe/likes/extra/deep">Jane's likes</a></li>
    <li><a href="/assets/logo.png">logo</a></li>
    <li><a href="/janedoe?tab=about">Jane again, filtered</a></li>
  </ul>
  <a href="https://twitter.com/platform">Follow us</a>
</body></html>`;

// A profile page: this is where the artist's own site finally appears.
const PROFILE_HTML = `
<html><body>
  <h1>Jane Doe</h1>
  <a href="/janedoe">Profile</a>
  <a href="https://janedoe.design">janedoe.design</a>
  <a href="https://twitter.com/janedoe">Twitter</a>
  <a href="https://www.artstation.com/janedoe">ArtStation</a>
</body></html>`;

describe("extractSameHostLinks", () => {
  const links = extractSameHostLinks({
    html: DIRECTORY_HTML,
    sourceUrl: "https://www.platform.test/search?sort_by=followers",
  });

  it("collects same-host listing entries", () => {
    expect(links).toContain("https://www.platform.test/janedoe");
    expect(links).toContain("https://www.platform.test/john-smith");
  });

  it("treats an absolute same-host URL the same as a relative one", () => {
    expect(links).toContain("https://www.platform.test/kim_lee");
  });

  it("allows a two-segment detail path", () => {
    expect(links).toContain("https://www.platform.test/studios/acme");
  });

  it("skips navigation and account plumbing", () => {
    for (const path of ["/", "/search", "/login", "/about", "/pricing"]) {
      expect(links).not.toContain(`https://www.platform.test${path}`);
    }
  });

  it("skips paths deeper than a detail page", () => {
    expect(links.some((l) => l.includes("/likes/extra/deep"))).toBe(false);
  });

  it("skips assets", () => {
    expect(links.some((l) => l.endsWith(".png"))).toBe(false);
  });

  it("collapses query-string variants onto one entry", () => {
    expect(links.filter((l) => l === "https://www.platform.test/janedoe")).toHaveLength(1);
  });

  it("never returns another host", () => {
    expect(links.some((l) => l.includes("twitter.com"))).toBe(false);
  });

  it("honours the limit", () => {
    expect(
      extractSameHostLinks({
        html: DIRECTORY_HTML,
        sourceUrl: "https://www.platform.test/search",
        limit: 2,
      }),
    ).toHaveLength(2);
  });
});

describe("two-hop shape", () => {
  it("finds nothing outbound on the directory page itself", () => {
    // The whole reason depth 2 exists: every listing is same-host, so the
    // first hop yields no businesses at all.
    const first = extractOutboundProspects({
      html: DIRECTORY_HTML,
      sourceUrl: "https://www.platform.test/search",
    });
    expect(first.map((p) => p.host)).not.toContain("platform.test");
    expect(first.some((p) => p.host.includes("janedoe"))).toBe(false);
  });

  it("finds the business site on the profile page", () => {
    const second = extractOutboundProspects({
      html: PROFILE_HTML,
      sourceUrl: "https://www.platform.test/janedoe",
    });
    expect(second.map((p) => p.host)).toContain("janedoe.design");
  });

  it("still filters platforms out on the second hop", () => {
    const hosts = extractOutboundProspects({
      html: PROFILE_HTML,
      sourceUrl: "https://www.platform.test/janedoe",
    }).map((p) => p.host);
    expect(hosts).not.toContain("twitter.com");
  });
});
