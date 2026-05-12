import type { FetchedPage } from "./types";

const UA = "CrawlProofBot/1.0 (+https://crawlproof.com/bot)";
const TIMEOUT_MS = 15_000;
const MAX_BYTES = 4 * 1024 * 1024;

export async function fetchPage(url: string): Promise<FetchedPage> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "user-agent": UA,
        accept: "text/html,application/xhtml+xml,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal: controller.signal,
    });

    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > MAX_BYTES) break;
        chunks.push(value);
      }
    }
    const body = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });

    return {
      url,
      finalUrl: res.url || url,
      status: res.status,
      fetchedAt: new Date().toISOString(),
      contentType: headers["content-type"] ?? null,
      headers,
      rawHtml: body,
      bytes: total,
      fetchMs: Date.now() - started,
    };
  } catch (err) {
    return {
      url,
      finalUrl: url,
      status: 0,
      fetchedAt: new Date().toISOString(),
      contentType: null,
      headers: {},
      rawHtml: "",
      bytes: 0,
      fetchMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeText(
  url: string,
): Promise<{ content: string; status: number } | undefined> {
  const p = await fetchPage(url);
  if (p.status === 0) return undefined;
  return { content: p.rawHtml, status: p.status };
}
