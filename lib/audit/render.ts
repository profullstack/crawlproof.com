import type { FetchedPage } from "./types";
import { CRAWL_BROWSER_SETTLE_MS, CRAWL_BROWSER_TIMEOUT_MS } from "../crawl/policy";

// Lazily-imported to avoid loading Playwright when not needed.
let _chromium: typeof import("playwright").chromium | null = null;
async function getChromium() {
  if (_chromium) return _chromium;
  const { chromium } = await import("playwright");
  _chromium = chromium;
  return chromium;
}

const UA = "CrawlProofBot/1.0 (+https://crawlproof.com/bot)";

export async function renderPage(url: string): Promise<{
  html: string;
  text: string;
  bytes: number;
  ms: number;
  error?: string;
}> {
  const started = Date.now();
  let browser: import("playwright").Browser | null = null;
  try {
    const chromium = await getChromium();
    browser = await chromium.launch({ args: ["--no-sandbox"] });
    const ctx = await browser.newContext({ userAgent: UA });
    const page = await ctx.newPage();
    // Fleet crawler policy: 30 s for the whole render. Wait for `load`, then a
    // bounded settle for late XHR — never an open-ended networkidle, which a
    // page that polls never reaches. A navigation timeout throws and is
    // returned as `error`, not read as an empty page.
    const deadline = Date.now() + CRAWL_BROWSER_TIMEOUT_MS;
    page.setDefaultTimeout(CRAWL_BROWSER_TIMEOUT_MS);
    await page.goto(url, { waitUntil: "load", timeout: CRAWL_BROWSER_TIMEOUT_MS });
    const settle = Math.min(CRAWL_BROWSER_SETTLE_MS, Math.max(0, deadline - Date.now()));
    if (settle > 0) await page.waitForLoadState("networkidle", { timeout: settle }).catch(() => {});
    const html = await page.content();
    const text = await page.evaluate(() => document.body?.innerText ?? "");
    return {
      html,
      text,
      bytes: Buffer.byteLength(html, "utf8"),
      ms: Date.now() - started,
    };
  } catch (err) {
    return {
      html: "",
      text: "",
      bytes: 0,
      ms: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

export async function attachRendered(page: FetchedPage): Promise<FetchedPage> {
  const r = await renderPage(page.url);
  // A failed render is recorded as a failure, not as a page with no text:
  // checks that read renderedText fall back to the raw HTML instead.
  if (r.error) return { ...page, renderError: r.error };
  return {
    ...page,
    renderedHtml: r.html,
    renderedText: r.text,
    renderedBytes: r.bytes,
  };
}
