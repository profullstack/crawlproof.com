// Human-in-the-loop verification-code (identity challenge) handling for
// browser-automated posts.
//
// Some platforms (LinkedIn especially) interrupt a cookie session with an
// "enter the 6-digit code we just emailed/texted you" challenge before showing
// the composer. We keep the SAME Playwright session open, mark the post
// 'awaiting_code' with a human-readable prompt, and poll sp_post for a code the
// user submits in the UI. When it arrives we type it into the live page and
// continue posting. If no code shows up within the timeout we give up so the
// browser (and its concurrency slot) is freed.

import type { Locator, Page } from "playwright";
import type { SupabaseClient } from "@supabase/supabase-js";

// A function a platform flow calls when it detects a challenge: it surfaces the
// prompt to the user and resolves with the code they enter (or throws on
// timeout).
export type CodeWaiter = (prompt: string) => Promise<string>;

const DEFAULT_TIMEOUT_MS = 3 * 60 * 1000; // 3 min — a browser slot is held open.
const DEFAULT_POLL_MS = 3 * 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Build a CodeWaiter bound to one post. Marks the post 'awaiting_code' (storing
// the prompt so the UI can show what's being asked), then polls until the user
// submits a code or we time out. On success it flips back to 'publishing' and
// clears the code so it can't be replayed.
export function makeCodeWaiter(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  postId: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): CodeWaiter {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;

  return async function waitForCode(prompt: string): Promise<string> {
    await supabase
      .from("sp_post")
      .update({
        status: "awaiting_code",
        verification_prompt: prompt,
        verification_requested_at: new Date().toISOString(),
        verification_code: null,
      })
      .eq("id", postId);

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(pollMs);
      const { data } = await supabase
        .from("sp_post")
        .select("verification_code")
        .eq("id", postId)
        .maybeSingle();
      const code = ((data?.verification_code as string | null) ?? "").trim();
      if (code) {
        await supabase
          .from("sp_post")
          .update({
            status: "publishing",
            verification_code: null,
            verification_prompt: null,
          })
          .eq("id", postId);
        return code;
      }
    }

    throw new Error(
      "Timed out waiting for the verification code. Enter it sooner and retry.",
    );
  };
}

// Best-effort detector for a verification-code input on the current page.
// Deliberately narrow (one-time-code / pin / otp / verification hints) to avoid
// mistaking a normal text field for a challenge. Returns the input + a likely
// submit control, or null when no challenge is visible.
export async function detectCodeChallenge(
  page: Page,
  timeoutMs = 2500,
): Promise<{ input: Locator; submit: Locator | null } | null> {
  const input = page
    .locator('input[autocomplete="one-time-code"]')
    .or(page.locator('input[name*="pin" i]'))
    .or(page.locator('input[id*="pin" i]'))
    .or(page.locator('input[name*="otp" i]'))
    .or(page.locator('input[name*="verification" i]'))
    .or(page.locator('input[id*="verification" i]'))
    .or(page.locator('input[aria-label*="verification code" i]'))
    .or(page.locator('input[name="code" i]'))
    .first();

  const visible = await input
    .waitFor({ state: "visible", timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);
  if (!visible) return null;

  const submit = page
    .getByRole("button", { name: /verify|submit|confirm|continue|next|done/i })
    .first();
  const hasSubmit = await submit.isVisible({ timeout: 1000 }).catch(() => false);
  return { input, submit: hasSubmit ? submit : null };
}

// If a code challenge is on the page, resolve it end-to-end: ask the user (via
// waitForCode), type the code, submit, and wait for the page to move on.
// Returns true if a challenge was handled, false if none was present. Safe to
// call at the top of every platform flow.
export async function handleCodeChallenge(
  page: Page,
  waitForCode: CodeWaiter,
  prompt: string,
): Promise<boolean> {
  const challenge = await detectCodeChallenge(page);
  if (!challenge) return false;

  const code = await waitForCode(prompt);
  await challenge.input.fill(code);
  if (challenge.submit) {
    await challenge.submit.click().catch(() => {});
  } else {
    await page.keyboard.press("Enter").catch(() => {});
  }
  // Let the challenge clear and the real app render.
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(2000);
  return true;
}
