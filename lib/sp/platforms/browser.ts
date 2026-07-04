// Browser-automation posting via Playwright.
//
// Used for platforms that require app-review approval or paid API access
// (Reddit, Facebook, Threads, Instagram). The user exports their session
// cookies via the Cookie-Editor browser extension and pastes the JSON into
// CrawlProof; we encrypt and store it in sp_account.enc_access_token.
//
// Each platform function launches a new browser context, loads the cookies,
// navigates to the post creation flow, fills the form, and submits. The
// browser is always closed in a finally block.
//
// Stealth: we set a realistic user-agent, viewport, and locale. Platforms
// do run bot detection but are less aggressive on posting flows than on
// scraping flows. Add playwright-extra + stealth plugin if detection becomes
// a problem.

import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { browserSemaphore } from "@/lib/sp/browserSemaphore";
import { handleCodeChallenge, type CodeWaiter } from "@/lib/sp/verificationChallenge";

// Standard challenge prompt shown to the user when a platform interrupts the
// session asking for a verification code.
function codePrompt(platform: string): string {
  return `${platform} is asking for a verification code. Enter the code it just sent (email / SMS / authenticator) to finish posting.`;
}

// Prefix on errors thrown when the cookie session is dead and the platform is
// showing a login wall. browserPost.ts recognizes it and flags the account as
// token_expired so the user is prompted to reconnect (re-export cookies).
export const LOGIN_WALL_PREFIX = "SESSION_EXPIRED";

// After navigating with cookies (and clearing any code challenge), bail out
// with a clear, recognizable error if we landed on a login page instead of the
// app — otherwise the composer selectors just time out opaquely. Detects a
// login URL or a visible password field.
async function assertLoggedIn(page: Page, platform: string): Promise<void> {
  const url = page.url().toLowerCase();
  const onLogin =
    /\/login|\/signin|\/sign_in|\/uas\/login|accounts\/login|accounts\/emailsignup|\/signup|\/auth\/login/.test(
      url,
    );
  const passwordVisible = await page
    .locator('input[type="password"]')
    .first()
    .isVisible({ timeout: 1500 })
    .catch(() => false);
  if (onLogin || passwordVisible) {
    throw new Error(
      `${LOGIN_WALL_PREFIX}: ${platform} session expired — reconnect the account with fresh cookies.`,
    );
  }
}

export type BrowserCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
};

export type BrowserPostResult = {
  platformPostId: string;
  webUrl: string;
};

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function launchContext(cookies: BrowserCookie[]): Promise<{
  browser: Browser;
  ctx: BrowserContext;
}> {
  // Hold a concurrency slot for the whole browser lifetime so we never run more
  // than SP_BROWSER_CONCURRENCY headless Chromiums at once (see
  // browserSemaphore). The slot is released when the browser disconnects, which
  // fires from every platform function's `finally { browser.close() }`.
  await browserSemaphore.acquire();
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      browserSemaphore.release();
    }
  };
  try {
    const browser = await chromium.launch({ headless: true });
    browser.once("disconnected", release);
    const ctx = await browser.newContext({
      userAgent: UA,
      viewport: { width: 1280, height: 800 },
      locale: "en-US",
      timezoneId: "America/New_York",
    });
    await ctx.addCookies(cookies);
    return { browser, ctx };
  } catch (err) {
    // Launch or context setup failed before we could attach the disconnect
    // handler — free the slot so a failure can't leak capacity.
    release();
    throw err;
  }
}

// Playwright's addCookies only accepts sameSite "Strict" | "Lax" | "None".
// Cookie-Editor / Chrome exports use other spellings ("no_restriction",
// "unspecified", lowercase "lax"/"strict") or null, which fail the enum check
// with: cookies[N].sameSite: expected one of (Strict|Lax|None). Map them.
function normalizeSameSite(value: unknown): BrowserCookie["sameSite"] {
  switch (String(value ?? "").toLowerCase()) {
    case "strict":
      return "Strict";
    case "none":
    case "no_restriction":
      return "None";
    default:
      // "lax", "unspecified", "", null, or anything unexpected.
      return "Lax";
  }
}

// Error carrying the page it failed on, so browserPost can persist the real
// authenticated DOM (sp_post.debug_html/url) for selector debugging.
export class BrowserPostError extends Error {
  pageUrl?: string;
  pageHtml?: string;
}

async function captureDom(page: Page, err: unknown): Promise<BrowserPostError> {
  const e = new BrowserPostError(err instanceof Error ? err.message : String(err));
  if (err instanceof Error && err.stack) e.stack = err.stack;
  try {
    e.pageUrl = page.url();
    // Trim — some platform pages are megabytes of inline JSON. This is plenty
    // to find the compose/form selectors.
    e.pageHtml = (await page.content()).slice(0, 600_000);
  } catch {
    // Page may already be gone; keep the original message.
  }
  return e;
}

export function parseCookies(raw: string): BrowserCookie[] {
  const parsed = JSON.parse(raw);
  const arr: unknown[] = Array.isArray(parsed) ? parsed : parsed.cookies ?? parsed;
  if (!Array.isArray(arr)) throw new Error("Cookie JSON must be an array.");
  return arr.map((c: any) => {
    const sameSite = normalizeSameSite(c.sameSite);
    return {
      name: c.name,
      value: c.value,
      domain: c.domain ?? c.host ?? "",
      path: c.path ?? "/",
      expires: c.expirationDate ?? c.expires ?? -1,
      httpOnly: c.httpOnly ?? false,
      // Chromium rejects SameSite=None cookies that aren't Secure.
      secure: (c.secure ?? false) || sameSite === "None",
      sameSite,
    };
  });
}

// ---------- Reddit ----------

export async function redditBrowserPost(args: {
  cookies: BrowserCookie[];
  subreddit: string;
  title: string;
  text: string;
  waitForCode?: CodeWaiter;
}): Promise<BrowserPostResult> {
  const { cookies, subreddit, title, text, waitForCode } = args;
  const sr = subreddit.replace(/^\/?r\//, "");
  const { browser, ctx } = await launchContext(cookies);
  const page = await ctx.newPage();
  try {
    await page.goto(`https://www.reddit.com/r/${sr}/submit`, {
      waitUntil: "domcontentloaded",
    });
    if (waitForCode) await handleCodeChallenge(page, waitForCode, codePrompt("Reddit"));
    await assertLoggedIn(page, "Reddit");

    // Select "Text" tab
    const textTab = page.getByRole("tab", { name: /text/i });
    if (await textTab.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await textTab.click();
    }

    // Title — new Reddit renders a <post-composer-title name="title"> web
    // component (confirmed from the live DOM); older layouts used a titled
    // input. Click and type so the component's internal field registers it.
    const titleField = page
      .locator("post-composer-title, faceplate-textarea[name='title']")
      .or(page.getByPlaceholder(/title/i))
      .or(page.locator('textarea[name="title"], input[name="title"]'))
      .first();
    await titleField.waitFor({ timeout: 12_000 });
    await titleField.click();
    await page.keyboard.type(title);

    // Body — a Lexical contenteditable inside <shreddit-composer name="body">
    // (confirmed: <div data-lexical-editor="true" contenteditable="true">).
    // Lexical ignores programmatic value setting, so type via the keyboard.
    const bodyEditor = page
      .locator('div[data-lexical-editor="true"][contenteditable="true"]')
      .or(page.locator('shreddit-composer [contenteditable="true"]'))
      .or(page.locator('[slot="editor"][contenteditable="true"]'))
      .or(page.locator('[data-testid="post-content"] [contenteditable="true"]'))
      .first();
    await bodyEditor.waitFor({ timeout: 12_000 });
    await bodyEditor.click();
    await page.keyboard.type(text);

    // Submit — the Post button lives in a shreddit web component; getByRole
    // pierces its open shadow root at runtime.
    await page
      .getByRole("button", { name: /^post$/i })
      .or(page.locator("#submit-post-button, button[type='submit']"))
      .first()
      .click();

    // Wait for redirect to the new post
    await page.waitForURL(/\/r\/[^/]+\/comments\//, { timeout: 15_000 });
    const postUrl = page.url();
    const match = postUrl.match(/\/comments\/([a-z0-9]+)\//);
    const postId = match ? `t3_${match[1]}` : postUrl;
    return { platformPostId: postId, webUrl: postUrl };
  } catch (err) {
    throw await captureDom(page, err);
  } finally {
    await browser.close();
  }
}

// ---------- Facebook Page ----------

export async function facebookBrowserPost(args: {
  cookies: BrowserCookie[];
  pageId: string;
  text: string;
  imageUrl?: string;
  waitForCode?: CodeWaiter;
}): Promise<BrowserPostResult> {
  const { cookies, pageId, text, imageUrl, waitForCode } = args;
  const { browser, ctx } = await launchContext(cookies);
  const page = await ctx.newPage();
  try {
    await page.goto(`https://www.facebook.com/${pageId}`, {
      waitUntil: "domcontentloaded",
    });
    if (waitForCode) await handleCodeChallenge(page, waitForCode, codePrompt("Facebook"));
    await assertLoggedIn(page, "Facebook");

    // Click the "Write something..." composer
    const composer = page.getByPlaceholder(/write something/i)
      .or(page.getByRole("button", { name: /write something/i }))
      .or(page.locator('[aria-label*="create"]').first())
      .first();
    await composer.waitFor({ timeout: 10_000 });
    await composer.click();

    // Type in the post dialog
    const editor = page.locator('[contenteditable="true"][role="textbox"]').first();
    await editor.waitFor({ timeout: 8_000 });
    await editor.fill(text);

    if (imageUrl) {
      // Photo/Video button
      const photoBtn = page.getByRole("button", { name: /photo.*video|add photo/i }).first();
      if (await photoBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await photoBtn.click();
        // Download the image and upload via file input
        const imgRes = await fetch(imageUrl);
        const buf = Buffer.from(await imgRes.arrayBuffer());
        const tmpPath = `/tmp/fb-post-${Date.now()}.jpg`;
        const fs = await import("node:fs/promises");
        await fs.writeFile(tmpPath, buf);
        const fileInput = page.locator('input[type="file"]').first();
        await fileInput.setInputFiles(tmpPath);
        await fs.unlink(tmpPath).catch(() => {});
        await page.waitForTimeout(2_000);
      }
    }

    // Post button
    await page.getByRole("button", { name: /^post$/i }).last().click();

    // Wait for the composer to close and extract the new post URL
    await page.waitForTimeout(4_000);
    // Facebook doesn't redirect after posting; try to find the latest post
    const postLink = page.locator('a[href*="/posts/"]').first();
    const href = await postLink.getAttribute("href").catch(() => null);
    const postUrl = href
      ? `https://www.facebook.com${href.startsWith("/") ? href : "/" + href}`
      : `https://www.facebook.com/${pageId}`;
    return { platformPostId: pageId, webUrl: postUrl };
  } catch (err) {
    throw await captureDom(page, err);
  } finally {
    await browser.close();
  }
}

// ---------- Threads ----------

export async function threadsBrowserPost(args: {
  cookies: BrowserCookie[];
  text: string;
  imageUrl?: string;
  waitForCode?: CodeWaiter;
}): Promise<BrowserPostResult> {
  const { cookies, text, imageUrl, waitForCode } = args;
  const { browser, ctx } = await launchContext(cookies);
  const page = await ctx.newPage();
  try {
    // Threads moved from threads.net to threads.com; the old domain redirects
    // (and threads.net cookies don't authenticate on .com).
    await page.goto("https://www.threads.com", { waitUntil: "domcontentloaded" });
    if (waitForCode) await handleCodeChallenge(page, waitForCode, codePrompt("Threads"));
    await assertLoggedIn(page, "Threads");

    // New Thread button
    const newThreadBtn = page
      .getByRole("link", { name: /new thread/i })
      .or(page.getByRole("button", { name: /new thread/i }))
      .or(page.locator('[aria-label*="thread" i]').first())
      .first();
    await newThreadBtn.waitFor({ timeout: 10_000 });
    await newThreadBtn.click();

    // Text editor in the compose dialog
    const editor = page.locator('[contenteditable="true"]').last();
    await editor.waitFor({ timeout: 8_000 });
    await editor.click();
    await editor.fill(text);

    if (imageUrl) {
      const imgBtn = page.locator('[aria-label*="image" i], [aria-label*="photo" i]').first();
      if (await imgBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await imgBtn.click();
        const imgRes = await fetch(imageUrl);
        const buf = Buffer.from(await imgRes.arrayBuffer());
        const tmpPath = `/tmp/threads-post-${Date.now()}.jpg`;
        const fs = await import("node:fs/promises");
        await fs.writeFile(tmpPath, buf);
        const fileInput = page.locator('input[type="file"]').first();
        await fileInput.setInputFiles(tmpPath);
        await fs.unlink(tmpPath).catch(() => {});
        await page.waitForTimeout(2_000);
      }
    }

    // Post button
    await page.getByRole("button", { name: /^post$/i }).last().click();

    // Threads stays on the same page; grab the post URL from the toast or DOM
    await page.waitForTimeout(4_000);
    const postLink = page.locator('a[href*="/post/"]').first();
    const href = await postLink.getAttribute("href").catch(() => null);
    const postUrl = href
      ? `https://www.threads.com${href.startsWith("/") ? href : "/" + href}`
      : "https://www.threads.com";
    return { platformPostId: href ?? "threads", webUrl: postUrl };
  } catch (err) {
    throw await captureDom(page, err);
  } finally {
    await browser.close();
  }
}

// ---------- Instagram ----------

export async function instagramBrowserPost(args: {
  cookies: BrowserCookie[];
  caption: string;
  imageUrl: string; // required — Instagram does not support text-only posts
  waitForCode?: CodeWaiter;
}): Promise<BrowserPostResult> {
  const { cookies, caption, imageUrl, waitForCode } = args;
  const { browser, ctx } = await launchContext(cookies);
  const page = await ctx.newPage();
  try {
    await page.goto("https://www.instagram.com", { waitUntil: "domcontentloaded" });
    if (waitForCode) await handleCodeChallenge(page, waitForCode, codePrompt("Instagram"));
    await assertLoggedIn(page, "Instagram");

    // Download image to temp file
    const imgRes = await fetch(imageUrl);
    const buf = Buffer.from(await imgRes.arrayBuffer());
    const tmpPath = `/tmp/ig-post-${Date.now()}.jpg`;
    const fs = await import("node:fs/promises");
    await fs.writeFile(tmpPath, buf);

    try {
      // Click the "+" / Create button in the nav
      const createBtn = page
        .getByRole("link", { name: /create/i })
        .or(page.locator('[aria-label="New post" i]'))
        .or(page.locator('svg[aria-label="New post" i]').locator(".."))
        .first();
      await createBtn.waitFor({ timeout: 10_000 });
      await createBtn.click();

      // File input (hidden; activated by the create dialog)
      const fileInput = page.locator('input[type="file"]').first();
      await fileInput.waitFor({ timeout: 8_000 });
      await fileInput.setInputFiles(tmpPath);

      // Next → Next → caption → Share flow
      const nextBtn = page.getByRole("button", { name: /next/i });
      await nextBtn.first().waitFor({ timeout: 8_000 });
      await nextBtn.first().click(); // crop step
      await page.waitForTimeout(1_000);
      await nextBtn.first().click(); // filter step
      await page.waitForTimeout(1_000);

      // Caption
      const captionBox = page.locator('textarea[aria-label*="caption" i], [contenteditable="true"]').first();
      await captionBox.waitFor({ timeout: 8_000 });
      await captionBox.fill(caption);

      // Share
      await page.getByRole("button", { name: /share/i }).last().click();
      await page.waitForTimeout(5_000);

      // Try to get the post URL from the success dialog
      const viewPostLink = page.getByRole("link", { name: /view post/i });
      const href = await viewPostLink.getAttribute("href").catch(() => null);
      const postUrl = href
        ? `https://www.instagram.com${href.startsWith("/") ? href : "/" + href}`
        : "https://www.instagram.com";
      return { platformPostId: href ?? "instagram", webUrl: postUrl };
    } finally {
      await fs.unlink(tmpPath).catch(() => {});
    }
  } catch (err) {
    throw await captureDom(page, err);
  } finally {
    await browser.close();
  }
}

// ---------- X (Twitter) ----------

export async function xBrowserPost(args: {
  cookies: BrowserCookie[];
  text: string;
  imageUrl?: string;
  waitForCode?: CodeWaiter;
}): Promise<BrowserPostResult> {
  const { cookies, text, imageUrl, waitForCode } = args;
  const { browser, ctx } = await launchContext(cookies);
  const page = await ctx.newPage();
  try {
    await page.goto("https://x.com/home", { waitUntil: "domcontentloaded" });
    if (waitForCode) await handleCodeChallenge(page, waitForCode, codePrompt("X"));
    await assertLoggedIn(page, "X");

    // Click the compose box
    const compose = page
      .getByRole("textbox", { name: /what is happening/i })
      .or(page.locator('[data-testid="tweetTextarea_0"]'))
      .first();
    await compose.waitFor({ timeout: 10_000 });
    await compose.click();
    await compose.fill(text);

    if (imageUrl) {
      const imgBtn = page.locator('[data-testid="fileInput"]').first()
        .or(page.locator('input[type="file"]').first());
      if (await imgBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
        const imgRes = await fetch(imageUrl);
        const buf = Buffer.from(await imgRes.arrayBuffer());
        const tmpPath = `/tmp/x-post-${Date.now()}.jpg`;
        const fs = await import("node:fs/promises");
        await fs.writeFile(tmpPath, buf);
        await imgBtn.setInputFiles(tmpPath);
        await fs.unlink(tmpPath).catch(() => {});
        await page.waitForTimeout(2_000);
      }
    }

    // Post button
    await page.locator('[data-testid="tweetButtonInline"]')
      .or(page.getByRole("button", { name: /^post$/i }))
      .first()
      .click();

    await page.waitForTimeout(4_000);
    // Try to find the new tweet URL from the response/DOM
    const tweetLink = page.locator('a[href*="/status/"]').first();
    const href = await tweetLink.getAttribute("href").catch(() => null);
    const postUrl = href
      ? `https://x.com${href.startsWith("/") ? href : "/" + href}`
      : "https://x.com";
    return { platformPostId: href ?? "x", webUrl: postUrl };
  } catch (err) {
    throw await captureDom(page, err);
  } finally {
    await browser.close();
  }
}

// ---------- LinkedIn ----------

export async function linkedinBrowserPost(args: {
  cookies: BrowserCookie[];
  text: string;
  imageUrl?: string;
  waitForCode?: CodeWaiter;
}): Promise<BrowserPostResult> {
  const { cookies, text, imageUrl, waitForCode } = args;
  const { browser, ctx } = await launchContext(cookies);
  const page = await ctx.newPage();
  try {
    await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded" });
    if (waitForCode) await handleCodeChallenge(page, waitForCode, codePrompt("LinkedIn"));
    await assertLoggedIn(page, "LinkedIn");

    // Start a post
    const startPost = page
      .getByRole("button", { name: /start a post/i })
      .or(page.locator('[data-control-name="share.sharebox_headline"]'))
      .first();
    await startPost.waitFor({ timeout: 10_000 });
    await startPost.click();

    // Editor in the share dialog
    const editor = page.locator('[data-placeholder*="talk about" i], [contenteditable="true"]').first();
    await editor.waitFor({ timeout: 8_000 });
    await editor.fill(text);

    if (imageUrl) {
      const photoBtn = page.getByLabel(/add a photo/i)
        .or(page.locator('[data-control-name="add_photo"]'))
        .first();
      if (await photoBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await photoBtn.click();
        const imgRes = await fetch(imageUrl);
        const buf = Buffer.from(await imgRes.arrayBuffer());
        const tmpPath = `/tmp/li-post-${Date.now()}.jpg`;
        const fs = await import("node:fs/promises");
        await fs.writeFile(tmpPath, buf);
        const fileInput = page.locator('input[type="file"]').first();
        await fileInput.setInputFiles(tmpPath);
        await fs.unlink(tmpPath).catch(() => {});
        await page.waitForTimeout(2_000);
        // Done button in media uploader
        const doneBtn = page.getByRole("button", { name: /done/i }).last();
        if (await doneBtn.isVisible({ timeout: 4_000 }).catch(() => false)) {
          await doneBtn.click();
          await page.waitForTimeout(1_000);
        }
      }
    }

    // Post button
    await page.getByRole("button", { name: /^post$/i }).last().click();
    await page.waitForTimeout(4_000);

    const postLink = page.locator('a[href*="/posts/"]').first();
    const href = await postLink.getAttribute("href").catch(() => null);
    const postUrl = href
      ? `https://www.linkedin.com${href.startsWith("/") ? href : "/" + href}`
      : "https://www.linkedin.com/feed/";
    return { platformPostId: href ?? "linkedin", webUrl: postUrl };
  } catch (err) {
    throw await captureDom(page, err);
  } finally {
    await browser.close();
  }
}

// ---------- Mastodon ----------

export async function mastodonBrowserPost(args: {
  cookies: BrowserCookie[];
  instanceUrl: string;
  text: string;
  imageUrl?: string;
  waitForCode?: CodeWaiter;
}): Promise<BrowserPostResult> {
  const { cookies, instanceUrl, text, imageUrl, waitForCode } = args;
  const base = instanceUrl.startsWith("http") ? instanceUrl : `https://${instanceUrl}`;
  const { browser, ctx } = await launchContext(cookies);
  const page = await ctx.newPage();
  try {
    await page.goto(base, { waitUntil: "domcontentloaded" });
    if (waitForCode) await handleCodeChallenge(page, waitForCode, codePrompt("Mastodon"));
    await assertLoggedIn(page, "Mastodon");

    // Mastodon web app — compose textarea. Match the compose box specifically:
    // a bare getByRole("textbox") also matched the "Search or paste URL" input
    // and tripped strict-mode. The compose box's aria-label is "What's on your
    // mind?" and it carries the autosuggest-textarea__textarea class.
    const compose = page
      .locator("textarea.autosuggest-textarea__textarea")
      .or(page.getByRole("textbox", { name: /what.?s on your mind/i }))
      .first();
    await compose.waitFor({ timeout: 10_000 });
    await compose.fill(text);

    if (imageUrl) {
      const attachBtn = page.locator('[title*="Attach" i], [aria-label*="attach" i], [aria-label*="image" i]').first();
      if (await attachBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await attachBtn.click();
        const imgRes = await fetch(imageUrl);
        const buf = Buffer.from(await imgRes.arrayBuffer());
        const tmpPath = `/tmp/masto-post-${Date.now()}.jpg`;
        const fs = await import("node:fs/promises");
        await fs.writeFile(tmpPath, buf);
        const fileInput = page.locator('input[type="file"]').first();
        await fileInput.setInputFiles(tmpPath);
        await fs.unlink(tmpPath).catch(() => {});
        await page.waitForTimeout(2_000);
      }
    }

    // Toot / Publish button. Mastodon labels it "Publish!" / "Toot!"; also
    // accept the compose form's submit button as a fallback.
    await page
      .getByRole("button", { name: /publish|toot/i })
      .or(page.locator("button.compose-form__submit"))
      .or(page.locator(".compose-form button[type='submit']"))
      .last()
      .click();

    await page.waitForTimeout(3_000);
    const postLink = page.locator('a.status__relative-time, a[href*="/statuses/"]').first();
    const href = await postLink.getAttribute("href").catch(() => null);
    const postUrl = href ?? base;
    return { platformPostId: href ?? "mastodon", webUrl: postUrl };
  } catch (err) {
    throw await captureDom(page, err);
  } finally {
    await browser.close();
  }
}
