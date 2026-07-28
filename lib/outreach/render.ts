// Headless-browser page rendering for seed discovery.
//
// A plain fetch only sees the HTML the server sent. A growing share of the
// pages worth seeding — marketplace category pages, artist and agency
// directories, anything built as an SPA — ship an empty shell and load the
// listings over XHR afterwards. Fetching those returns 200 and zero links,
// which reads as "this directory has no businesses on it" rather than "we
// couldn't see them".
//
// This renders the page in Chromium instead, which is deliberately generic:
// no per-directory API clients to write and re-write as each site changes its
// endpoints.
//
// Chromium is already in the production image (mcr.microsoft.com/playwright),
// so this costs memory at runtime rather than image size. To keep that bounded
// the browser is launched once and shared, images/media/fonts are blocked
// (they cost bandwidth and memory and never contain a link), and the whole
// thing shuts itself down after a spell of inactivity rather than pinning a
// Chromium process for the life of the container.
//
// What this does NOT do is defeat bot protection. A site behind a Cloudflare
// managed challenge stays blocked — headless and headed Chromium both sit on
// the interstitial from a datacenter IP, and the page never renders. Rendering
// solves "the HTML arrives empty", not "the site doesn't want us".

import type { Browser, BrowserContext } from "playwright";
import { isPrivateAddress } from "./mailboxDiscovery";
import dns from "node:dns/promises";
import net from "node:net";

const NAV_TIMEOUT_MS = 25_000;
const SETTLE_MS = 2_500;
const IDLE_SHUTDOWN_MS = 60_000;
const MAX_HTML_BYTES = 3 * 1024 * 1024;

// Chromium is heavy enough that a per-call launch would dominate the cost of
// a campaign tick, so one instance is shared across renders.
let browserPromise: Promise<Browser> | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let inFlight = 0;

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    // Imported lazily so that importing this module — which the discovery
    // path does unconditionally — doesn't pull Chromium bindings into
    // processes that never render anything.
    browserPromise = import("playwright").then(({ chromium }) =>
      chromium.launch({
        args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
      }),
    );
  }
  return browserPromise;
}

function touchIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (inFlight > 0) return;
    void closeBrowser();
  }, IDLE_SHUTDOWN_MS);
  // Don't hold the process open just to keep an idle browser around.
  idleTimer.unref?.();
}

export async function closeBrowser(): Promise<void> {
  const pending = browserPromise;
  browserPromise = null;
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (!pending) return;
  try {
    const browser = await pending;
    await browser.close();
  } catch {
    // Already gone, or never started — nothing to clean up.
  }
}

/**
 * Seed URLs come from users, so a renderer will happily point at anything it
 * is given. Resolve first and refuse anything in private space.
 */
async function hostIsPublic(hostname: string): Promise<boolean> {
  if (net.isIP(hostname)) return !isPrivateAddress(hostname);
  try {
    const addrs = await dns.lookup(hostname, { all: true });
    return addrs.length > 0 && addrs.every((a) => !isPrivateAddress(a.address));
  } catch {
    return false;
  }
}

export type RenderResult =
  | { ok: true; html: string; status: number; finalUrl: string }
  | { ok: false; error: string; status?: number; challenged?: boolean };

/** Page titles a bot-protection interstitial serves instead of the real page. */
const CHALLENGE_RE = /just a moment|attention required|verifying you are human|checking your browser/i;

/**
 * Load `url` in Chromium and return the DOM after scripts have run.
 *
 * Resolves rather than throws: discovery treats a failed render as "this seed
 * produced nothing", not as a reason to abort a campaign tick.
 */
export async function renderPage(url: string): Promise<RenderResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "not a valid URL" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, error: "only http(s) URLs can be rendered" };
  }
  if (!(await hostIsPublic(parsed.hostname))) {
    return { ok: false, error: "host does not resolve, or resolves to a private address" };
  }

  let context: BrowserContext | null = null;
  inFlight += 1;
  try {
    const browser = await getBrowser();
    context = await browser.newContext({
      userAgent: UA,
      viewport: { width: 1440, height: 900 },
      locale: "en-US",
      javaScriptEnabled: true,
    });

    // Images, media and fonts carry no links and dominate page weight.
    await context.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (type === "image" || type === "media" || type === "font") return route.abort();
      return route.continue();
    });

    const page = await context.newPage();
    page.setDefaultTimeout(NAV_TIMEOUT_MS);

    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT_MS,
    });
    const status = response?.status() ?? 0;

    // Let XHR-driven listings arrive. networkidle is the obvious choice but
    // never fires on pages that poll or hold a socket open, so this waits for
    // quiet with a hard ceiling instead.
    await page
      .waitForLoadState("networkidle", { timeout: SETTLE_MS * 2 })
      .catch(() => page.waitForTimeout(SETTLE_MS));

    const title = await page.title().catch(() => "");
    if (CHALLENGE_RE.test(title)) {
      return {
        ok: false,
        status,
        challenged: true,
        error:
          "the site served a bot-protection challenge instead of the page — rendering can't get past it",
      };
    }
    if (status >= 400) {
      return { ok: false, status, error: `rendered with HTTP ${status}` };
    }

    const html = await page.content();
    return {
      ok: true,
      status,
      finalUrl: page.url(),
      html: html.length > MAX_HTML_BYTES ? html.slice(0, MAX_HTML_BYTES) : html,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message.slice(0, 200) : "render failed",
    };
  } finally {
    inFlight -= 1;
    if (context) await context.close().catch(() => {});
    touchIdleTimer();
  }
}
