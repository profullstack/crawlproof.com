#!/usr/bin/env -S npx tsx
// Render one creative in both polarities into a single page, so the pair can
// be eyeballed the way a publisher would see them. Writes HTML to stdout.

import { renderCreativeHtml } from "../lib/ads/creative";
import type { AdCreative, AdFormatId } from "../lib/ads/formats";

const base: Omit<AdCreative, "format"> = {
  headline: "Ship it on Friday",
  body: "Pay per click, set a daily cap, stop whenever you want.",
  ctaText: "Try it free",
  bgColor: "#0b0d10",
  fgColor: "#ffffff",
  accentColor: "#6ee7b7",
  lightBgColor: null,
  lightFgColor: null,
  lightAccentColor: null,
  fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
  logoUrl: null,
  imageUrl: null,
};

const formats: AdFormatId[] = ["text_link", "banner_728x90", "banner_300x250", "banner_320x50"];
const cell = (f: AdFormatId, theme: "light" | "dark") =>
  `<iframe style="border:0;width:${f === "text_link" ? "600px" : "auto"};height:${f === "text_link" ? 40 : f === "banner_728x90" ? 90 : f === "banner_320x50" ? 50 : 250}px" srcdoc="${renderCreativeHtml({ ...base, format: f }, "https://example.com", { theme }).replace(/"/g, "&quot;")}"></iframe>`;

console.log(`<!doctype html><meta charset="utf-8"><body style="margin:0;font:14px system-ui">
<section style="background:#ffffff;color:#111;padding:24px">
  <h2 style="margin:0 0 4px">On a white page (light variant)</h2>
  <p style="margin:0 0 16px;color:#555">This is the case that was broken: a plain black-on-white blog.</p>
  ${formats.map((f) => cell(f, "light")).join("<br><br>")}
</section>
<section style="background:#0b0d10;color:#eee;padding:24px">
  <h2 style="margin:0 0 4px">On a dark page (dark variant)</h2>
  <p style="margin:0 0 16px;color:#9aa">Unchanged from before.</p>
  ${formats.map((f) => cell(f, "dark")).join("<br><br>")}
</section>
</body>`);
