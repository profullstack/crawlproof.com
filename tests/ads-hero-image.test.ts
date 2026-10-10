import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/onion", () => ({ smartFetch: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({ serviceClient: vi.fn() }));

import { buildPrompt, buildSafePrompt, looksLikeIcon } from "@/lib/ads/heroImage";
import type { SiteBrand } from "@/lib/ads/brand";

const brand = {
  domain: "pwamart.com",
  title: "Zombie AI: install the web app",
  description: "Create your own AI zombie love story with two photos.",
} as SiteBrand;
const copy = { headline: "Make a zombie love story", body: "Two photos in.", bgColor: "#101814", accentColor: "#e2582f" };

describe("ad hero prompts", () => {
  it("carries the product, the copy, the palette and the agentic-era art direction", () => {
    const p = buildPrompt(brand, copy);
    expect(p).toContain("agentic AI era");
    expect(p).toContain("Zombie AI");
    expect(p).toContain("Make a zombie love story");
    expect(p).toContain("#101814");
    expect(p).toContain("#e2582f");
  });

  it("drops every word of advertiser copy from the safety retry", () => {
    const p = buildSafePrompt(brand, copy);
    expect(p).not.toMatch(/zombie/i);
    expect(p).toContain("pwamart.com");
    expect(p).toContain("agentic AI era");
    expect(p).toContain("#e2582f");
  });
});

describe("looksLikeIcon", () => {
  it("refuses app icons and logos as a hero", () => {
    expect(looksLikeIcon("https://pwamart.com/icon-512.png")).toBe(true);
    expect(looksLikeIcon("https://x.com/favicon.ico")).toBe(true);
    expect(looksLikeIcon("https://x.com/apple-touch-icon.png")).toBe(true);
    expect(looksLikeIcon("https://x.com/static/logo.svg?v=2")).toBe(true);
  });

  it("keeps real share images", () => {
    expect(looksLikeIcon("https://x.com/og.png")).toBe(false);
    expect(looksLikeIcon("https://x.com/images/hero-launch.jpg")).toBe(false);
    expect(looksLikeIcon("https://x.com/blog/iconic-design/cover.png")).toBe(false);
  });
});
