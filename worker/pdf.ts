import { chromium } from "playwright";

const PDF_MARGIN = { top: "0.6in", bottom: "0.6in", left: "0.4in", right: "0.4in" };
const UA = "CrawlProofPDF/1.0 (+https://crawlproof.com/bot)";

export async function renderPdf(url: string): Promise<Buffer> {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const ctx = await browser.newContext({ userAgent: UA });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
    return await page.pdf({
      format: "A4",
      margin: PDF_MARGIN,
      printBackground: true,
    });
  } finally {
    await browser.close().catch(() => {});
  }
}

// PDF from a self-contained HTML document (e.g. pandoc/marked output).
export async function renderPdfFromHtml(html: string): Promise<Buffer> {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const ctx = await browser.newContext({ userAgent: UA });
    const page = await ctx.newPage();
    await page.setContent(html, { waitUntil: "networkidle", timeout: 30_000 });
    return await page.pdf({
      format: "A4",
      margin: PDF_MARGIN,
      printBackground: true,
    });
  } finally {
    await browser.close().catch(() => {});
  }
}
