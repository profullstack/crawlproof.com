// Sitemap discovery helpers.
//
// detectSitemapUrl: best-effort probe of a site for its sitemap location.
// Order:
//   1. /robots.txt "Sitemap:" directive (authoritative per RFC 9309)
//   2. /sitemap.xml
//   3. /sitemap_index.xml
//
// Returns the first URL that responds with HTTP 200. Does NOT validate the
// XML body — the worker job will do that on first crawl.

const FETCH_TIMEOUT_MS = 5000;
const UA = "Crawlproof-LinkExchange/1.0 (+https://crawlproof.com)";

async function fetchHead(url: string): Promise<number | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // HEAD first — many CDNs answer instantly. Fall back to GET if HEAD is
    // blocked (some WAFs return 405 on HEAD).
    const head = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": UA },
    });
    if (head.status === 405 || head.status === 501) {
      const get = await fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: { "user-agent": UA },
      });
      return get.status;
    }
    return head.status;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": UA },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function originOf(domain: string): string | null {
  try {
    const u = new URL(/^https?:\/\//i.test(domain) ? domain : `https://${domain}`);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

export async function detectSitemapUrl(domain: string): Promise<string | null> {
  const origin = originOf(domain);
  if (!origin) return null;

  const robots = await fetchText(`${origin}/robots.txt`);
  if (robots) {
    for (const line of robots.split(/\r?\n/)) {
      const m = line.match(/^\s*sitemap\s*:\s*(\S+)/i);
      if (m) return m[1];
    }
  }

  for (const path of ["/sitemap.xml", "/sitemap_index.xml"]) {
    const url = `${origin}${path}`;
    const status = await fetchHead(url);
    if (status === 200) return url;
  }

  return null;
}
