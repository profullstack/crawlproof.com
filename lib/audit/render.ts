import type { FetchedPage } from "./types";

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
    await page.goto(url, { waitUntil: "networkidle", timeout: 20_000 });
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
  return {
    ...page,
    renderedHtml: r.html,
    renderedText: r.text,
    renderedBytes: r.bytes,
  };
}
