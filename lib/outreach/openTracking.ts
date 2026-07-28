// Open tracking, one token per send.
//
// A pixel keyed to the campaign can only ever say "somebody opened something",
// which is not a fact anybody can act on. Keyed to the send it says which
// person opened which email, which is what decides who to follow up.
//
// The honest caveat is built in rather than written on a help page. Mail
// privacy proxies — Apple Mail Privacy Protection, Gmail's image cache — fetch
// every image the moment a message arrives, whether or not a human ever looks
// at it. An open counted from one of those is a lie, so fetches that carry a
// proxy's fingerprint or arrive implausibly fast are recorded separately and
// kept out of the count.

import crypto from "node:crypto";
import { serviceClient } from "@/lib/supabase/service";

/** 1×1 transparent GIF. Smaller than the equivalent PNG and older than most mail clients. */
export const PIXEL_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);

/**
 * Below this, a fetch is the recipient's mail server, not the recipient.
 *
 * A human cannot receive, notice and open an email inside ten seconds often
 * enough to matter; a caching proxy does it every time. Discarding the window
 * costs a few genuine same-second opens and removes a systematic overcount.
 */
const PREFETCH_WINDOW_MS = 10_000;

/** User-agent fragments belonging to something that fetches on the recipient's behalf. */
const PROXY_AGENTS = [
  "googleimageproxy",
  "yahoomailproxy",
  "proofpoint",
  "barracuda",
  "mimecast",
  "symantec",
  "microsoft office",
  "bingpreview",
  "skypeuripreview",
  "slackbot",
  "whatsapp",
  "twitterbot",
  "facebookexternalhit",
];

export function newTrackToken(): string {
  return crypto.randomBytes(16).toString("hex");
}

export function pixelUrl(siteBase: string, token: string): string {
  // .gif on the end so clients that sniff by extension are satisfied, and so
  // the URL reads as an image to a human looking at raw source.
  return `${siteBase}/api/o/${token}.gif`;
}

/**
 * The tracking pixel, as HTML.
 *
 * Empty alt and role="presentation" so a screen reader does not announce a
 * spacer image, and inline dimensions so a client that blocks images shows
 * nothing rather than a broken-image box in the middle of the mail.
 */
export function pixelHtml(url: string): string {
  return `<img src="${url}" width="1" height="1" alt="" role="presentation" style="display:block;width:1px;height:1px;border:0;opacity:0;" />`;
}

/**
 * Whether a fetch looks like a proxy rather than a person.
 *
 * Deliberately generous: counting a proxy as an open corrupts the one number
 * the funnel exists to report, while discarding a real open only understates
 * it. An understated open rate is a survivable error; an inflated one gets
 * somebody to keep sending into a void.
 */
export function looksLikePrefetch(input: {
  userAgent: string | null;
  sentAt: Date;
  now: Date;
}): boolean {
  const ua = (input.userAgent ?? "").toLowerCase();
  if (!ua) return true; // No client identifies itself as nothing. A scanner does.
  if (PROXY_AGENTS.some((p) => ua.includes(p))) return true;
  const elapsed = input.now.getTime() - input.sentAt.getTime();
  // Negative elapsed means clock skew between the sender and this request; a
  // fetch that appears to precede its own email is not evidence of anything.
  if (elapsed < PREFETCH_WINDOW_MS) return true;
  return false;
}

export type OpenResult =
  | { kind: "unknown" }
  | { kind: "prefetch" }
  | { kind: "open"; first: boolean };

/**
 * Record one image load.
 *
 * Never throws and never reveals whether the token matched: the route serves
 * the same pixel either way, so a token cannot be probed for validity.
 */
export async function recordOpen(input: {
  token: string;
  userAgent: string | null;
  now?: Date;
}): Promise<OpenResult> {
  const now = input.now ?? new Date();
  const sb = serviceClient();

  const { data } = await sb
    .from("outreach_sends")
    .select("id, sent_at, opened_at, open_count, prefetch_count, dry_run")
    .eq("track_token", input.token)
    .maybeSingle();

  const row = data as Record<string, unknown> | null;
  if (!row) return { kind: "unknown" };
  // A dry run was never delivered, so anything fetching its pixel is us.
  if (row.dry_run) return { kind: "unknown" };

  const sentAt = new Date(row.sent_at as string);
  if (looksLikePrefetch({ userAgent: input.userAgent, sentAt, now })) {
    await sb
      .from("outreach_sends")
      .update({ prefetch_count: ((row.prefetch_count as number) ?? 0) + 1 })
      .eq("id", row.id as string);
    return { kind: "prefetch" };
  }

  const first = !row.opened_at;
  await sb
    .from("outreach_sends")
    .update({
      // opened_at is the first open and never moves; last_opened_at is the
      // most recent. Collapsing them into one column would answer "have they
      // looked again" by destroying the answer to "when did they first look".
      opened_at: first ? now.toISOString() : (row.opened_at as string),
      last_opened_at: now.toISOString(),
      open_count: ((row.open_count as number) ?? 0) + 1,
    })
    .eq("id", row.id as string);

  return { kind: "open", first };
}
