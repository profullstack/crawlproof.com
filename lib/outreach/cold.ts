// Pure logic for cold email outreach.
//
// Everything here is side-effect free so the decisions that actually carry
// risk — who we're allowed to contact, which address on a site is a person,
// how many sends are left today — can be tested without a mail provider or a
// database attached. The failure mode of getting these wrong is not an
// exception; it is a mail to someone who asked us never to write again, which
// costs the sending domain.
//
// The paid tools this replaces (Velvet Forge's build_pitch, Signal Found's
// DM cannon) have no equivalent layer: they generate and send. Everything
// below exists because CrawlProof sends from its own domain.

/** Addresses we never contact: our own, and machine mailboxes. */
const INTERNAL = /@(profullstack\.com|crawlproof\.com)$/i;

/**
 * Local parts that are never a buyer. Note what is NOT here: info@, hello@,
 * contact@, sales@ and team@ are the correct target for cold B2B outreach at
 * a small business — they are the address the business publishes precisely so
 * strangers can write to it. The newsletter campaign (lib/leadCampaign.ts)
 * excludes all role accounts because it mails people who opted in personally;
 * this list is deliberately narrower.
 */
const NEVER_CONTACT_LOCALPART =
  /^(noreply|no-reply|donotreply|do-not-reply|mailer-daemon|postmaster|abuse|dmca|security|privacy|legal|unsubscribe|bounce|bounces)$/i;

/** Ranked best-first. A named human beats a shared inbox beats a department. */
const ROLE_PREFERENCE = [
  "hello",
  "hi",
  "contact",
  "info",
  "team",
  "office",
  "sales",
  "support",
  "admin",
  "webmaster",
];

export type SuppressionReason =
  | "suppressed"
  | "unsubscribed"
  | "internal"
  | "never-contact-mailbox"
  | "invalid-address"
  | "already-contacted"
  | "daily-cap";

export type ContactCandidate = {
  email: string;
  /** Where we found it — shown in the draft so a human can sanity-check. */
  source: "mailto" | "text" | "manual";
  /** True when the address is on the prospect's own domain. */
  sameDomain: boolean;
};

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}/g;

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeHost(value: string): string {
  const raw = value.trim().toLowerCase();
  const withScheme = /^https?:\/\//.test(raw) ? raw : `https://${raw}`;
  try {
    return new URL(withScheme).hostname.replace(/^www\./, "");
  } catch {
    return raw.replace(/^www\./, "").split("/")[0] ?? "";
  }
}

export function localPart(email: string): string {
  return normalizeEmail(email).split("@")[0] ?? "";
}

export function domainOf(email: string): string {
  return normalizeEmail(email).split("@")[1] ?? "";
}

export function isNeverContactMailbox(email: string): boolean {
  return NEVER_CONTACT_LOCALPART.test(localPart(email));
}

/**
 * Reasonable-address check. Not RFC 5322 — that grammar accepts things no
 * mail provider will deliver to and rejecting a valid oddity costs nothing
 * here (the operator can pass it explicitly).
 */
export function looksLikeEmail(value: string): boolean {
  const email = normalizeEmail(value);
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}$/.test(email)) return false;
  // "logo@2x.png" satisfies the grammar. Asset filenames written that way are
  // common in markup, and every one of them is an undeliverable address.
  return !/\.(png|jpe?g|gif|svg|webp|avif|ico|css|js|mjs|json|woff2?|ttf|mp4|webm|pdf)$/.test(email);
}

export type SuppressionInput = {
  email: string;
  /** Rows from outreach_suppressions matching this address or its domain. */
  suppressed: boolean;
  /** marketing_contacts.unsubscribed_at — one opt-out covers every channel. */
  unsubscribedAt?: string | null;
  /** A prior non-dry-run send to this address in this campaign + step. */
  alreadyContacted?: boolean;
  /** Live sends already made by this user in the last 24h. */
  sentToday?: number;
  dailyCap?: number;
};

/**
 * The single gate every live send passes through. Ordered by severity: an
 * explicit "stop contacting me" outranks a cap, because the cap is a
 * throttle and the suppression is a promise.
 */
export function suppressionReason(input: SuppressionInput): SuppressionReason | null {
  const email = normalizeEmail(input.email);
  if (!looksLikeEmail(email)) return "invalid-address";
  if (input.suppressed) return "suppressed";
  if (input.unsubscribedAt) return "unsubscribed";
  if (INTERNAL.test(email)) return "internal";
  if (isNeverContactMailbox(email)) return "never-contact-mailbox";
  if (input.alreadyContacted) return "already-contacted";
  const cap = input.dailyCap ?? 0;
  if (cap > 0 && (input.sentToday ?? 0) >= cap) return "daily-cap";
  return null;
}

export function explainSuppression(reason: SuppressionReason): string {
  switch (reason) {
    case "suppressed":
      return "on the do-not-contact list";
    case "unsubscribed":
      return "unsubscribed from CrawlProof email";
    case "internal":
      return "an internal address";
    case "never-contact-mailbox":
      return "a machine mailbox (noreply/postmaster/abuse) — not a person";
    case "invalid-address":
      return "not a deliverable-looking address";
    case "already-contacted":
      return "already contacted at this step of this campaign";
    case "daily-cap":
      return "over the daily send cap";
  }
}

/**
 * Pull candidate contact addresses out of a page's HTML.
 *
 * mailto: links first because they are unambiguous; bare text addresses are
 * a fallback and are noisier (they catch schema.org blobs and, occasionally,
 * a third party's address in a testimonial — hence sameDomain, which the
 * ranking uses to keep us on the prospect's own domain).
 */
export function discoverContactEmails(html: string, host: string): ContactCandidate[] {
  const apex = apexOf(host);
  const out = new Map<string, ContactCandidate>();

  for (const match of html.matchAll(/mailto:([^"'?>\s]+)/gi)) {
    const email = normalizeEmail(decodeURIComponent(match[1] ?? ""));
    if (!looksLikeEmail(email)) continue;
    out.set(email, { email, source: "mailto", sameDomain: apexOf(domainOf(email)) === apex });
  }

  // Strip tags so we don't harvest addresses out of tracking-script config
  // blobs, which are mostly vendor addresses and never the owner's.
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ");
  for (const match of text.matchAll(EMAIL_RE)) {
    const email = normalizeEmail(match[0]);
    if (!looksLikeEmail(email) || out.has(email)) continue;
    // Image filenames and asset hashes routinely satisfy the address shape.
    if (/\.(png|jpe?g|gif|svg|webp|css|js)$/i.test(email)) continue;
    out.set(email, { email, source: "text", sameDomain: apexOf(domainOf(email)) === apex });
  }

  return rankContacts([...out.values()]);
}

function apexOf(host: string): string {
  const parts = normalizeHost(host).split(".");
  return parts.slice(-2).join(".");
}

/**
 * Best-first ordering. On-domain always beats off-domain — an off-domain
 * address on a small business site is usually their web developer, their
 * booking vendor, or a customer quote, and mailing it pitches the wrong
 * person about someone else's website.
 */
export function rankContacts(candidates: ContactCandidate[]): ContactCandidate[] {
  const scored = candidates
    .filter((c) => !isNeverContactMailbox(c.email))
    .map((c) => {
      let score = 0;
      if (c.sameDomain) score += 100;
      if (c.source === "mailto") score += 20;
      const idx = ROLE_PREFERENCE.indexOf(localPart(c.email));
      // A local part we don't recognise is likely a person's name, which is
      // the best possible target — worth more than the mailto: bonus, so a
      // named human in body text still outranks info@ in a mailto link.
      score += idx === -1 ? 30 : 10 - idx;
      return { c, score };
    })
    .sort((a, b) => b.score - a.score);
  return scored.map((s) => s.c);
}

export function bestContact(candidates: ContactCandidate[]): ContactCandidate | null {
  const ranked = rankContacts(candidates);
  return ranked.find((c) => c.sameDomain) ?? ranked[0] ?? null;
}

/** Pages worth fetching when hunting for a contact address, in order. */
export const CONTACT_PATHS = ["/", "/contact", "/contact-us", "/about", "/about-us"];

export type OutreachStep = 1 | 2 | 3;

/**
 * What each message in a 3-step sequence is allowed to be. The steps are
 * deliberately different jobs, not the same pitch resent — a "just bumping
 * this" with no new information is what makes a sequence feel automated.
 */
export function stepGuidance(step: OutreachStep): string {
  switch (step) {
    case 1:
      return [
        "First contact. They have never heard from us.",
        "Lead with the single most concrete defect found on their site — the specific one, named, with the evidence.",
        "Explain in one sentence why it costs them something real (an AI assistant answering wrong about them, a page nobody can cite).",
        "One ask: a link to their free report. Do not ask for a call.",
      ].join(" ");
    case 2:
      return [
        "Second contact, ~4 days later. They did not reply to the first.",
        "Must contain NEW information — a second finding, or what the fix actually involves. Never 'just following up' with nothing added.",
        "Shorter than the first message. Three sentences is plenty.",
        "Same single ask.",
      ].join(" ");
    case 3:
      return [
        "Final contact. Close the loop and mean it.",
        "State plainly that this is the last message and that they will not hear from us again.",
        "Leave the report link so it is still useful if they come back to it later.",
        "No new pitch, no discount, no urgency. Two or three sentences.",
      ].join(" ");
  }
}

/** Days after the previous step before the next one may go out. */
export const STEP_DELAY_DAYS: Record<OutreachStep, number> = { 1: 0, 2: 4, 3: 7 };

export function nextStepReadyAt(lastSentAt: Date, nextStep: OutreachStep): Date {
  const d = new Date(lastSentAt);
  d.setUTCDate(d.getUTCDate() + STEP_DELAY_DAYS[nextStep]);
  return d;
}

export type ProspectFacts = {
  host: string;
  score: number | null;
  /** Which dial the score is on — slop runs the opposite way to AEO. */
  kind: "aeo" | "slop";
  topIssues: string[];
  reportUrl: string | null;
  quoteUsd: number | null;
};

/**
 * A cold subject line states the finding. It never asks a question the
 * recipient can answer "no" to, and it never implies a prior relationship —
 * "following up on our conversation" to someone we have never met is the
 * lie that gets a domain blocked.
 */
export function outreachSubject(facts: ProspectFacts, step: OutreachStep): string {
  const issue = facts.topIssues[0];
  if (step === 3) return `Last note about ${facts.host}`;
  if (step === 2) {
    return issue ? `${facts.host}: ${lowerFirst(issue)}` : `One more thing about ${facts.host}`;
  }
  if (facts.score !== null) {
    return facts.kind === "slop"
      ? `${facts.host} — ${facts.score}/100 on the carelessness scan`
      : `${facts.host} scores ${facts.score}/100 with AI answer engines`;
  }
  return issue ? `${facts.host}: ${lowerFirst(issue)}` : `A scan of ${facts.host}`;
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/**
 * Grounding guard. The whole premise of doing this from CrawlProof rather
 * than from a generic pitch generator is that every claim traces to a scan we
 * ran. A draft that mentions a finding we do not have is worse than no draft:
 * it is a confident false statement about someone's website, sent to them.
 */
export function unsupportedClaims(body: string, facts: ProspectFacts): string[] {
  const problems: string[] = [];
  const lower = body.toLowerCase();

  if (facts.score === null && /\b\d{1,3}\s*\/\s*100\b/.test(body)) {
    problems.push("cites a score, but this prospect has no score on file");
  }
  if (facts.score !== null) {
    for (const m of body.matchAll(/\b(\d{1,3})\s*\/\s*100\b/g)) {
      if (Number(m[1]) !== facts.score) {
        problems.push(`cites ${m[1]}/100 but the report says ${facts.score}/100`);
      }
    }
  }
  if (!facts.reportUrl && /\b(report|full results|see the scan)\b/.test(lower)) {
    problems.push("refers to a report, but there is no shareable report link");
  }
  // Fabricated familiarity is the single most common tell in generated cold
  // email, and it is always false on first contact.
  for (const phrase of [
    "as we discussed",
    "following up on our call",
    "great speaking with you",
    "as promised",
    "per our conversation",
    "thanks for your time yesterday",
  ]) {
    if (lower.includes(phrase)) problems.push(`implies a prior relationship: "${phrase}"`);
  }
  return problems;
}
