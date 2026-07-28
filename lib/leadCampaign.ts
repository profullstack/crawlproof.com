// Audience selection for the lead re-engagement campaign.
//
// Pure, so the thing that decides WHO gets emailed can be tested without a
// mail provider attached. Getting this wrong doesn't throw an exception — it
// silently mails someone who opted out, which is the failure mode that costs
// a sending domain.

export type LeadRow = {
  email: string;
  host: string;
  reportToken: string | null;
  score: number | null;
  scoreLabel: string;
  /** Which dial the score is on — the two run in opposite directions. */
  kind: "aeo" | "slop";
  scaleHint: string;
  topIssues: string[];
  /** Has a profiles row — an existing relationship, not a cold lead. */
  isCustomer: boolean;
  unsubscribedAt: string | null;
  consentedAt: string | null;
  /** True when this campaign already mailed this address. */
  alreadySent?: boolean;
};

export type Segment = "users" | "leads" | "all";

/** Addresses we never mail: our own, and role accounts that aren't a person. */
const INTERNAL = /@(profullstack\.com|crawlproof\.com)$/i;
const ROLE_LOCALPART =
  /^(postmaster|abuse|noreply|no-reply|donotreply|mailer-daemon|admin|webmaster|hostmaster)@/i;

/**
 * Hosts nobody in our audience owns. Someone who scanned x.com or wikipedia.org
 * was trying the tool, not auditing their property — asking "want us to fix
 * it?" about a site they can't change reads as a mailshot that didn't look at
 * its own data. They stay leads; they're just the wrong audience for THIS
 * pitch.
 */
const THIRD_PARTY_HOSTS = [
  "google.com", "share.google", "docs.google.com", "x.com", "twitter.com",
  "youtube.com", "facebook.com", "instagram.com", "linkedin.com", "github.com",
  "wikipedia.org", "linktr.ee", "sciencedirect.com", "medium.com", "reddit.com",
  "amazon.com", "notion.so", "chatgpt.com", "openai.com", "apple.com",
  "microsoft.com", "tiktok.com", "pinterest.com", "yahoo.com", "bing.com",
];

export function isThirdPartyHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^www\./, "");
  if (!h) return false;
  const apex = h.split(".").slice(-2).join(".");
  return THIRD_PARTY_HOSTS.some((t) => h === t || apex === t || h.endsWith(`.${t}`));
}

export type ExclusionReason =
  | "unsubscribed"
  | "internal"
  | "role-account"
  | "no-report"
  | "third-party-scan"
  | "already-sent"
  | "wrong-segment";

export function excludeReason(row: LeadRow, segment: Segment): ExclusionReason | null {
  // Unsubscribe beats everything, including an explicit later consent record —
  // if both are set, the safe reading is that they want out.
  if (row.unsubscribedAt) return "unsubscribed";
  if (INTERNAL.test(row.email)) return "internal";
  if (ROLE_LOCALPART.test(row.email)) return "role-account";
  // The whole message is about their report. Without one there is nothing to
  // say, and it degrades into the generic blast we're avoiding.
  if (!row.reportToken) return "no-report";
  if (isThirdPartyHost(row.host)) return "third-party-scan";
  // Set by the caller from the campaign_sends log — nobody gets this twice.
  if (row.alreadySent) return "already-sent";
  if (segment === "users" && !row.isCustomer) return "wrong-segment";
  if (segment === "leads" && row.isCustomer) return "wrong-segment";
  return null;
}

export function selectRecipients(
  rows: LeadRow[],
  segment: Segment,
): { send: LeadRow[]; excluded: Array<{ email: string; reason: ExclusionReason }> } {
  const send: LeadRow[] = [];
  const excluded: Array<{ email: string; reason: ExclusionReason }> = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const key = row.email.trim().toLowerCase();
    // One send per address even if they scanned five sites.
    if (seen.has(key)) continue;
    seen.add(key);

    const reason = excludeReason(row, segment);
    if (reason) excluded.push({ email: key, reason });
    else send.push({ ...row, email: key });
  }
  return { send, excluded };
}

/**
 * A site that already scores well is the wrong audience for a "want us to fix
 * it?" pitch — it reads as a canned mailshot and costs credibility with
 * exactly the people most likely to be competent buyers. Note the inverted
 * slop dial: strong means LOW there and HIGH for AEO.
 */
export function isStrongScore(row: LeadRow): boolean {
  if (row.score === null) return false;
  return row.kind === "slop" ? row.score <= 25 : row.score >= 80;
}

export function campaignSubject(row: LeadRow): string {
  if (row.score === null) return `Your CrawlProof scan of ${row.host}`;
  if (isStrongScore(row)) return `${row.host} scores ${row.score}/100 — the last few gaps`;
  return `${row.host} scored ${row.score}/100 — want us to fix it?`;
}

/** Deep-links /hire with what we already know, so the form is half-filled. */
export function hireUrlFor(row: LeadRow, siteUrl: string): string {
  const base = siteUrl.replace(/\/$/, "");
  const params = new URLSearchParams({
    website: `https://${row.host}`,
    email: row.email,
    utm_source: "lead-campaign",
    utm_medium: "email",
  });
  return `${base}/hire?${params.toString()}`;
}
