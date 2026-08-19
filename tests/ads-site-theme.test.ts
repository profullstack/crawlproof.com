import { describe, expect, it, vi, afterEach } from "vitest";

// detectSiteTheme fetches through lib/onion's smartFetch. Stub it so these are
// pure parser tests with no network.
const fetchMock = vi.fn();
vi.mock("@/lib/onion", () => ({ smartFetch: (...a: unknown[]) => fetchMock(...a) }));

const { detectSiteTheme } = await import("@/lib/ads/siteTheme");

function reply(body: string) {
  return { ok: true, text: async () => body };
}

/** Serve an HTML document plus a map of stylesheet path -> css. */
function serve(html: string, sheets: Record<string, string> = {}) {
  fetchMock.mockImplementation(async (url: string) => {
    for (const [path, css] of Object.entries(sheets)) {
      if (url.includes(path)) return reply(css);
    }
    if (url.endsWith(".css")) return { ok: false, text: async () => "" };
    return reply(html);
  });
}

afterEach(() => fetchMock.mockReset());

describe("detectSiteTheme", () => {
  it("calls a page with no declared background light", async () => {
    // The case the whole feature exists for: a plain blog with no CSS. The
    // browser paints white no matter what the visitor's OS prefers.
    serve("<html><body><h1>hi</h1></body></html>");
    const v = await detectSiteTheme("https://example.com");
    expect(v.theme).toBe("light");
  });

  it("reads a background off an inline style block", async () => {
    serve("<html><head><style>body{background:#0b0d10}</style></head><body></body></html>");
    expect((await detectSiteTheme("https://example.com")).theme).toBe("dark");
  });

  it("reads a background out of a linked stylesheet", async () => {
    serve('<html><head><link rel="stylesheet" href="/a.css"></head><body></body></html>', {
      "/a.css": "body{background-color:#ffffff}",
    });
    expect((await detectSiteTheme("https://example.com")).theme).toBe("light");
  });

  it("resolves a custom property, which is how real stylesheets declare it", async () => {
    // body { background: var(--bg) } with --bg on :root. Without resolution
    // this finds no background and wrongly falls through to light.
    serve('<html><head><link rel="stylesheet" href="/a.css"></head><body></body></html>', {
      "/a.css": ":root{--bg:#0d1117}body{background:var(--bg)}",
    });
    const v = await detectSiteTheme("https://example.com");
    expect(v.theme).toBe("dark");
    expect(v.reason).toContain("#0d1117");
  });

  it("takes the last layer of a layered background, not the first colour it sees", async () => {
    // `radial-gradient(... accent ...), var(--bg)` — the accent is a decorative
    // wash painted OVER the base layer. CSS only allows a colour on the final
    // layer, and the base is what a reader sees behind the text.
    serve('<html><head><link rel="stylesheet" href="/a.css"></head><body></body></html>', {
      "/a.css":
        ":root{--bg:#0d1117;--accent:#3fb98a}body{background:radial-gradient(1200px 620px at 50% -10%, var(--accent), transparent 70%), var(--bg)}",
    });
    const v = await detectSiteTheme("https://example.com");
    expect(v.theme).toBe("dark");
    expect(v.reason).toContain("#0d1117");
  });

  it("ignores a prefers-color-scheme override when deciding the default", async () => {
    // A light site with a dark mode is a light site. Which one a given visitor
    // sees is measured by the tag at fill time, not guessed from the CSS.
    serve('<html><head><link rel="stylesheet" href="/a.css"></head><body></body></html>', {
      "/a.css":
        ":root{--bg:#fbfaf8}body{background:var(--bg)}@media (prefers-color-scheme: dark){:root{--bg:#12110f}}",
    });
    const v = await detectSiteTheme("https://example.com");
    expect(v.theme).toBe("light");
    expect(v.reason).toContain("#fbfaf8");
  });

  it("does not let a component background decide the page", async () => {
    // Only html/body/:root count. A dark card on a white page is not a dark page.
    serve('<html><head><link rel="stylesheet" href="/a.css"></head><body></body></html>', {
      "/a.css": ".card{background:#0b0d10}.nav{background-color:#111}",
    });
    expect((await detectSiteTheme("https://example.com")).theme).toBe("light");
  });

  it("honours an explicit dark color-scheme", async () => {
    serve("<html><head><style>:root{color-scheme:dark}</style></head><body></body></html>");
    expect((await detectSiteTheme("https://example.com")).theme).toBe("dark");
  });

  it("treats 'light dark' as no verdict, because it adapts", async () => {
    serve("<html><head><style>:root{color-scheme:light dark}</style></head><body></body></html>");
    // Falls through to the browser-default answer rather than guessing.
    expect((await detectSiteTheme("https://example.com")).reason).toContain("browser default");
  });

  it("reports an unreachable site rather than guessing", async () => {
    fetchMock.mockImplementation(async () => ({ ok: false, text: async () => "" }));
    const v = await detectSiteTheme("https://example.com");
    expect(v.theme).toBeNull();
    expect(v.reason).toBe("unreachable");
  });

  it("ignores a commented-out rule", async () => {
    serve("<html><head><style>/* body{background:#000} */</style></head><body></body></html>");
    expect((await detectSiteTheme("https://example.com")).theme).toBe("light");
  });
});
