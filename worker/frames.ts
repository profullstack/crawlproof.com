// Playwright frame capture for the five-second pre-roll.
//
// Lives in worker/ beside pdf.ts because Chromium is a worker-image dependency:
// the Next.js app must never import this, and lib/ads/video/render.ts takes a
// capturer as a parameter precisely so it does not have to.

import { chromium, type Browser } from "playwright";
import path from "node:path";

/**
 * Everything the composed document needs is already inlined as a data: URI, so
 * the page has no legitimate reason to touch the network. Blocking it outright
 * turns the renderer from a request-forgery primitive — a browser we run, on
 * our own network, rendering advertiser-influenced content — into a pure
 * function of its input. It also makes renders reproducible, since nothing can
 * depend on what some URL served today.
 */
const ALLOWED_SCHEMES = /^(data|blob|about):/;

export type CaptureArgs = {
  html: string;
  outDir: string;
  frames: number;
  width: number;
  height: number;
};

export async function captureFrames(args: CaptureArgs): Promise<void> {
  const browser: Browser = await chromium.launch({
    args: [
      "--no-sandbox",
      // Deterministic rasterisation: without this, GPU/driver differences
      // between a developer's machine and the Railway container change
      // antialiasing, which changes bytes, which changes the sha256 of a
      // render whose hash is supposed to mean "these exact inputs".
      "--disable-gpu",
      "--force-color-profile=srgb",
      "--disable-lcd-text",
      "--hide-scrollbars",
    ],
  });

  try {
    const ctx = await browser.newContext({
      viewport: { width: args.width, height: args.height },
      // 1:1 pixels. A device scale factor would silently render at 2x and make
      // every rendition a downscale of the wrong source size.
      deviceScaleFactor: 1,
      // The composition handles reduced motion itself, from the snapshot flag,
      // so the browser must not also apply its own preference on top.
      reducedMotion: "no-preference",
    });

    await ctx.route("**/*", (route) => {
      const url = route.request().url();
      if (ALLOWED_SCHEMES.test(url)) return route.continue();
      return route.abort();
    });

    const page = await ctx.newPage();
    await page.setContent(args.html, { waitUntil: "load", timeout: 30_000 });
    // Fonts must be settled before the first screenshot, or frame 0 is captured
    // in a fallback face and the ad visibly re-flows one frame in.
    await page.evaluate(async () => {
      if (document.fonts) await document.fonts.ready;
    });

    const stage = page.locator(".stage");

    for (let i = 0; i < args.frames; i++) {
      // The document's own seek function is the single definition of what
      // frame i looks like; the capturer never computes animation state.
      await page.evaluate((frame) => (window as unknown as {
        __seek: (n: number) => Promise<unknown>;
      }).__seek(frame), i);
      await stage.screenshot({
        path: path.join(args.outDir, `f-${String(i).padStart(4, "0")}.png`),
        // No animations to disable — nothing in the document is time-driven —
        // but asking for it is cheap insurance against a future stylesheet
        // reintroducing a CSS transition and making captures racy again.
        animations: "disabled",
      });
    }
  } finally {
    await browser.close().catch(() => {});
  }
}
