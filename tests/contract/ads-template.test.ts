import { describe, expect, it, vi } from "vitest";
import { hasAdToken, parseAdTokens, renderAdTemplate } from "@/lib/ads/template";
import { TERMINAL_COLS } from "@/lib/ads/terminal";

// {{ads}} is the substitution point for surfaces that can't run /ad.js — the
// publisher's server swaps it for a fill before responding.

describe("parseAdTokens", () => {
  it("defaults to a terminal ad at the default width", () => {
    expect(parseAdTokens("hello\n{{ads}}\nbye")).toEqual([
      { raw: "{{ads}}", format: "terminal_ascii", cols: TERMINAL_COLS },
    ]);
  });

  it("accepts the singular alias and inner whitespace", () => {
    expect(parseAdTokens("{{ ad }}")[0].raw).toBe("{{ ad }}");
    expect(parseAdTokens("{{ ad }}")[0].format).toBe("terminal_ascii");
  });

  it("reads a bare number as a column count", () => {
    expect(parseAdTokens("{{ads:64}}")[0]).toMatchObject({ format: "terminal_ascii", cols: 64 });
  });

  it("clamps out-of-range widths", () => {
    expect(parseAdTokens("{{ads:5}}")[0].cols).toBe(44);
    expect(parseAdTokens("{{ads:9999}}")[0].cols).toBe(120);
  });

  it("reads a format name, by id or friendly alias", () => {
    expect(parseAdTokens("{{ads:terminal}}")[0].format).toBe("terminal_ascii");
    expect(parseAdTokens("{{ads:terminal_ascii}}")[0].format).toBe("terminal_ascii");
    expect(parseAdTokens("{{ads:text_link}}")[0].format).toBe("text_link");
    expect(parseAdTokens("{{ads:leaderboard}}")[0].format).toBe("banner_728x90");
  });

  it("reads format and width together", () => {
    expect(parseAdTokens("{{ads:terminal:100}}")[0]).toMatchObject({
      format: "terminal_ascii",
      cols: 100,
    });
  });

  it("falls back to the terminal format for unknown names", () => {
    expect(parseAdTokens("{{ads:hologram}}")[0].format).toBe("terminal_ascii");
  });

  it("finds every token, in order", () => {
    const tokens = parseAdTokens("{{ads}}\n---\n{{ads:48}}\n---\n{{ads}}");
    expect(tokens.map((t) => t.cols)).toEqual([TERMINAL_COLS, 48, TERMINAL_COLS]);
  });

  it("ignores text that isn't a token", () => {
    expect(parseAdTokens("no ads here, {{ adsense }}, {ads}")).toEqual([]);
    expect(hasAdToken("plain text")).toBe(false);
    expect(hasAdToken("x {{ads}} y")).toBe(true);
  });
});

describe("renderAdTemplate", () => {
  it("returns the template untouched when there is no token", async () => {
    const fill = vi.fn();
    expect(await renderAdTemplate("nothing here", fill)).toBe("nothing here");
    expect(fill).not.toHaveBeenCalled();
  });

  it("substitutes the fill in place", async () => {
    const out = await renderAdTemplate("top\n{{ads}}\nbottom", async () => "[AD]");
    expect(out).toBe("top\n[AD]\nbottom");
  });

  it("fills each distinct token once, reusing it for repeats", async () => {
    const fill = vi.fn(async (t) => `[${t.cols}]`);
    const out = await renderAdTemplate("{{ads}} {{ads}} {{ads:48}}", fill);
    expect(out).toBe(`[${TERMINAL_COLS}] [${TERMINAL_COLS}] [48]`);
    expect(fill).toHaveBeenCalledTimes(2);
  });

  it("drops the token when the fill fails — never leaks {{ads}} to the reader", async () => {
    const out = await renderAdTemplate("a{{ads}}b", async () => {
      throw new Error("ad server down");
    });
    expect(out).toBe("ab");
    expect(await renderAdTemplate("a{{ads}}b", async () => null)).toBe("ab");
  });

  it("is safe to call repeatedly (no regex lastIndex leakage)", async () => {
    const t = "x {{ads}} y";
    expect(await renderAdTemplate(t, async () => "AD")).toBe("x AD y");
    expect(await renderAdTemplate(t, async () => "AD")).toBe("x AD y");
    expect(hasAdToken(t)).toBe(true);
    expect(hasAdToken(t)).toBe(true);
  });
});
