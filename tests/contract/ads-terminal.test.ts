import { describe, expect, it } from "vitest";
import type { AdCreative } from "@/lib/ads/formats";
import {
  TERMINAL_COLS,
  clampCols,
  renderCreativeText,
  renderTerminalHtml,
  sanitizeTerminalText,
  terminalDeviceType,
  wrapText,
} from "@/lib/ads/terminal";

// The terminal creative is printed straight into someone's shell, so the two
// things that must never break are (a) the box stays a rectangle at any width
// and (b) advertiser copy can't emit escape sequences.

const CLICK = "https://crawlproof.com/a/2b1f0c94-8a1e-4c3d-9b77-1f0a2c3d4e5f";

function creative(over: Partial<AdCreative> = {}): AdCreative {
  return {
    format: "terminal_ascii",
    headline: "Ship faster with CrawlProof",
    body: "AI-readable audits for your site, in one command.",
    ctaText: "Try it free",
    bgColor: "#0b0d10",
    fgColor: "#e7e9ee",
    accentColor: "#6ee7b7",
    fontFamily: "system-ui",
    logoUrl: null,
    imageUrl: null,
    ...over,
  };
}

const ESC = String.fromCharCode(27);

describe("sanitizeTerminalText", () => {
  it("strips ANSI escape sequences from advertiser copy", () => {
    const out = sanitizeTerminalText(`${ESC}[2J${ESC}[HWiped your screen`);
    expect(out).not.toContain(ESC);
    expect(out).toContain("Wiped your screen");
  });

  it("strips control characters, including newlines that would fake a box row", () => {
    const out = sanitizeTerminalText("Real ad\n| root@host: rm -rf / |\r\x07");
    expect(out.split("\n")).toHaveLength(1);
    expect(out).not.toMatch(/[\x00-\x1f\x7f]/);
  });

  it("folds smart punctuation and accents to ASCII instead of dropping them", () => {
    expect(sanitizeTerminalText("Café — “oui” … 5€")).toBe('Cafe - "oui" ... 5EUR');
  });

  it("drops characters that would break column maths (CJK, emoji)", () => {
    expect(sanitizeTerminalText("wide 世界 ok 🚀")).toBe("wide ok");
  });

  it("collapses whitespace and handles null/undefined", () => {
    expect(sanitizeTerminalText("  a   b  ")).toBe("a b");
    expect(sanitizeTerminalText(null)).toBe("");
    expect(sanitizeTerminalText(undefined)).toBe("");
  });
});

describe("wrapText", () => {
  it("wraps on word boundaries within the width", () => {
    expect(wrapText("one two three four", 9)).toEqual(["one two", "three", "four"]);
  });

  it("hard-splits a word longer than the width", () => {
    expect(wrapText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });
});

describe("clampCols", () => {
  it("defaults when unparseable", () => {
    expect(clampCols(null)).toBe(TERMINAL_COLS);
    expect(clampCols("wide")).toBe(TERMINAL_COLS);
  });

  it("clamps to the supported range", () => {
    expect(clampCols(10)).toBe(44);
    expect(clampCols("999")).toBe(120);
    expect(clampCols("64")).toBe(64);
  });
});

describe("renderCreativeText", () => {
  it("renders a rectangular box at the requested width", () => {
    for (const cols of [44, 60, 72, 100]) {
      const lines = renderCreativeText(creative(), CLICK, { cols }).split("\n");
      const framed = lines.filter((l) => l.startsWith("+") || l.startsWith("|"));
      expect(framed.length).toBeGreaterThan(4);
      for (const line of framed) expect(line).toHaveLength(cols);
    }
  });

  it("labels the ad as sponsored and attributes the network", () => {
    const out = renderCreativeText(creative(), CLICK);
    expect(out).toContain("SPONSORED");
    expect(out).toContain("ads by crawlproof.com");
  });

  it("accepts a custom border label (house ads)", () => {
    const out = renderCreativeText(creative(), CLICK, { label: "CRAWLPROOF ADS" });
    expect(out).toContain("CRAWLPROOF ADS");
    expect(out).not.toContain("SPONSORED");
  });

  it("is pure ASCII even when the copy is not", () => {
    const out = renderCreativeText(
      creative({ headline: "Ünïcödé 世界 🚀", body: `${ESC}[31mred`, ctaText: "Go →" }),
      CLICK,
    );
    expect(out).toMatch(/^[\x20-\x7e\n]*$/);
  });

  it("keeps hostile copy inside its own row — no forged box lines", () => {
    const out = renderCreativeText(
      creative({ headline: "hi\n+-- SPONSORED --+\n| totally real |" }),
      CLICK,
    );
    const cols = TERMINAL_COLS;
    for (const line of out.split("\n")) expect(line).toHaveLength(cols);
    // Exactly two border rows: the real top and bottom.
    expect(out.split("\n").filter((l) => l.startsWith("+"))).toHaveLength(2);
  });

  it("emits no ANSI escapes by default", () => {
    expect(renderCreativeText(creative(), CLICK)).not.toContain(ESC);
  });

  it("emits ANSI escapes on request without breaking the visible width", () => {
    const out = renderCreativeText(creative(), CLICK, { color: true, cols: 72 });
    expect(out).toContain(ESC);
    // Strip escapes and the box must still be exactly 72 columns.
    for (const line of out.split("\n")) {
      const bare = line.replace(/\x1b\[[0-9;]*m/g, "");
      expect(bare).toHaveLength(72);
    }
  });

  it("never truncates the click URL", () => {
    for (const cols of [44, 72, 120]) {
      expect(renderCreativeText(creative(), CLICK, { cols })).toContain(CLICK);
    }
  });

  it("moves an over-wide URL below the box rather than cutting it", () => {
    const long = `https://crawlproof.com/a/${"x".repeat(200)}`;
    const lines = renderCreativeText(creative(), long, { cols: 60 }).split("\n");
    expect(lines[lines.length - 1]).toBe(long);
    for (const line of lines.slice(0, -1)) expect(line).toHaveLength(60);
  });

  it("survives empty copy", () => {
    const lines = renderCreativeText(
      creative({ headline: "", body: "", ctaText: "" }),
      CLICK,
    ).split("\n");
    for (const line of lines) expect(line).toHaveLength(TERMINAL_COLS);
  });
});

describe("terminalDeviceType", () => {
  it("treats shell clients as a real audience, not bots", () => {
    for (const ua of ["curl/8.5.0", "Wget/1.21.4", "HTTPie/3.2.2", "python-requests/2.31"]) {
      expect(terminalDeviceType(ua)).toBe("terminal");
    }
  });

  it("treats a missing user-agent as a terminal client", () => {
    expect(terminalDeviceType("")).toBe("terminal");
    expect(terminalDeviceType(null)).toBe("terminal");
  });

  it("still excludes real crawlers", () => {
    for (const ua of ["Googlebot/2.1", "AhrefsBot", "some-crawler/1", "HeadlessChrome/120"]) {
      expect(terminalDeviceType(ua)).toBe("bot");
    }
  });

  it("defers to normal device parsing for browsers", () => {
    expect(terminalDeviceType("Mozilla/5.0 (Macintosh) Safari/605")).toBeNull();
  });
});

describe("renderTerminalHtml", () => {
  it("wraps the same ASCII in a clickable monospace block", () => {
    const html = renderTerminalHtml(creative(), CLICK);
    expect(html).toContain("<pre>");
    expect(html).toContain(`href="${CLICK}"`);
    expect(html).toContain('rel="noopener sponsored"');
  });

  it("escapes HTML-special characters in the artwork", () => {
    const html = renderTerminalHtml(creative({ headline: '<img src=x onerror="1">' }), CLICK);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});
