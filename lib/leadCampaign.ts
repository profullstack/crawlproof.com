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
  scaleHint: string;
  topIssues: string[];
  /** Has a profiles row — an existing relationship, not a cold lead. */
  isCustomer: boolean;
  unsubscribedAt: string | null;
  consentedAt: string | null;
};

export type Segment = "users" | "leads" | "all";

/** Addresses we never mail: our own, and role accounts that aren't a person. */
const INTERNAL = /@(profullstack\.com|crawlproof\.com)$/i;
const ROLE_LOCALPART =
  /^(postmaster|abuse|noreply|no-reply|donotreply|mailer-daemon|admin|webmaster|hostmaster)@/i;

export type ExclusionReason =
  | "unsubscribed"
  | "internal"
  | "role-account"
  | "no-report"
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

export function campaignSubject(row: LeadRow): string {
  if (row.score === null) return `Your CrawlProof scan of ${row.host}`;
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
