// Sign in to a seed directory, generically.
//
// The alternative is a per-site login script, which is the thing we are
// trying not to build: every directory would need one, and each would break
// on its own schedule. A login form is well enough standardised to drive
// blind — one password field, one identifier field near it, one submit —
// and a directory that gates its listings behind a sign-in is almost always
// using an ordinary form.
//
// Scope note: this is for ordinary gated directories. It is not going to get
// anyone into a site that fights automation — those answer a server-side
// login attempt with a checkpoint, a second factor, or a rate limit, none of
// which a form fill can satisfy. Detection stays useful there; this doesn't.

import type { Page } from "playwright";
import { handleCodeChallenge, type CodeWaiter } from "@/lib/sp/verificationChallenge";

/** Hostname of a URL, for the prompt shown to the user. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "this site";
  }
}

export type SeedCredentials = {
  username: string;
  password: string;
  /** Where the login form lives, when discovery already found it. */
  loginUrl?: string;
};

export type LoginOutcome = { ok: true } | { ok: false; error: string };

const FIELD_TIMEOUT_MS = 8_000;
const SETTLE_MS = 6_000;

// Ordered by how strongly each names an identifier field. `email` before
// `user` because a form with both usually wants the email.
const USERNAME_SELECTORS = [
  'input[type="email"]:visible',
  'input[name*="email" i]:visible',
  'input[id*="email" i]:visible',
  'input[autocomplete="username"]:visible',
  'input[name*="user" i]:visible',
  'input[id*="user" i]:visible',
  'input[name*="login" i]:visible',
  'input[type="text"]:visible',
];

const SUBMIT_SELECTORS = [
  'button[type="submit"]:visible',
  'input[type="submit"]:visible',
  'button:has-text("Log in"):visible',
  'button:has-text("Sign in"):visible',
  'button:has-text("Continue"):visible',
];

/** Text a site shows when it wants more than a password. */
const EXTRA_STEP_RE =
  /(two[- ]factor|verification code|security code|one[- ]time|authenticator|confirm your identity|unusual activity|suspicious|captcha|checkpoint|are you a robot)/i;

const BAD_CREDENTIALS_RE =
  /(incorrect|invalid|wrong password|didn'?t match|not recognised|not recognized|try again)/i;

/**
 * Fill and submit the login form on `page`, then confirm it took.
 *
 * Returns a plain outcome rather than throwing: a failed login means this
 * seed produced nothing, not that the campaign should stop.
 */
export async function submitLoginForm(
  page: Page,
  creds: SeedCredentials,
  /**
   * Supplied when there is a user around to answer a verification code. The
   * server cannot answer one itself — and shouldn't be able to, since the
   * whole point of the code is that it reaches the account's owner — but the
   * owner can, so the session is held open and the prompt surfaced to them.
   */
  waitForCode?: CodeWaiter,
): Promise<LoginOutcome> {
  // The password field is the anchor: if there isn't one, this isn't a login
  // form and guessing at the rest would only produce noise.
  const password = page.locator('input[type="password"]:visible').first();
  try {
    await password.waitFor({ state: "visible", timeout: FIELD_TIMEOUT_MS });
  } catch {
    return { ok: false, error: "no password field was found on the login page" };
  }

  let filledUsername = false;
  for (const selector of USERNAME_SELECTORS) {
    const field = page.locator(selector).first();
    if ((await field.count()) === 0) continue;
    try {
      await field.fill(creds.username, { timeout: 2_000 });
      filledUsername = true;
      break;
    } catch {
      // Not editable, or covered by an overlay — try the next shape.
    }
  }
  if (!filledUsername) {
    return { ok: false, error: "no username or email field was found on the login page" };
  }

  try {
    await password.fill(creds.password, { timeout: 2_000 });
  } catch {
    return { ok: false, error: "the password field would not accept input" };
  }

  // Submitting: a click is preferred because some forms bind handlers to the
  // button, but pressing Enter in the password field is the reliable fallback
  // for forms whose button is a styled div.
  let submitted = false;
  for (const selector of SUBMIT_SELECTORS) {
    const button = page.locator(selector).first();
    if ((await button.count()) === 0) continue;
    try {
      await button.click({ timeout: 3_000 });
      submitted = true;
      break;
    } catch {
      // Fall through.
    }
  }
  if (!submitted) {
    try {
      await password.press("Enter");
      submitted = true;
    } catch {
      return { ok: false, error: "the login form could not be submitted" };
    }
  }

  await page
    .waitForLoadState("networkidle", { timeout: SETTLE_MS })
    .catch(() => page.waitForTimeout(2_500));

  let body = await page.content().catch(() => "");

  // A verification code is answerable, just not by us. With a waiter the
  // prompt goes to the user, their code is typed into this same live session,
  // and the sign-in carries on.
  if (waitForCode) {
    try {
      const handled = await handleCodeChallenge(
        page,
        waitForCode,
        `Signing in to ${hostOf(page.url())} needs a verification code. Check the inbox or phone for that account and enter the code here.`,
      );
      if (handled) body = await page.content().catch(() => "");
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error && /timed out/i.test(error.message)
            ? "the site asked for a verification code and none was entered in time"
            : "the verification code was not accepted",
      };
    }
  }

  // Still asking for something extra, with nobody able to answer it.
  if (EXTRA_STEP_RE.test(body)) {
    return {
      ok: false,
      error: waitForCode
        ? "the site asked for a step beyond a verification code (a device approval or a captcha) that can't be answered this way"
        : "the site asked for a verification code, and no one was available to enter it",
    };
  }

  // Still showing a password field means the submit bounced.
  const stillOnForm = (await page.locator('input[type="password"]:visible').count()) > 0;
  if (stillOnForm) {
    return {
      ok: false,
      error: BAD_CREDENTIALS_RE.test(body)
        ? "the site rejected that username and password"
        : "the login form was still showing after submitting",
    };
  }

  return { ok: true };
}
