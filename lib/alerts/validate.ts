// Abuse & cost controls for alert signup and query creation (PRD §7 P0).

// A small block-list of common disposable/temporary email providers. Not
// exhaustive by design — it stops the low-effort abuse that inflates SERP
// spend without maintaining a giant list. Extend via ALERT_DISPOSABLE_EXTRA.
const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com",
  "guerrillamail.com",
  "10minutemail.com",
  "temp-mail.org",
  "tempmail.com",
  "throwawaymail.com",
  "yopmail.com",
  "getnada.com",
  "trashmail.com",
  "sharklasers.com",
  "dispostable.com",
  "maildrop.cc",
  "mintemail.com",
  "fakeinbox.com",
  "tempinbox.com",
  "mohmal.com",
  "emailondeck.com",
  "spam4.me",
  "mailnesia.com",
  "moakt.com",
]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email.trim());
}

export function isDisposableEmail(email: string): boolean {
  const domain = email.trim().toLowerCase().split("@")[1] ?? "";
  const extra = (process.env.ALERT_DISPOSABLE_EXTRA ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  return DISPOSABLE_DOMAINS.has(domain) || extra.includes(domain);
}

const MAX_QUERY_LEN = 512;
const MAX_TERM_LEN = 200;

// Patterns we refuse to monitor — CSAM-adjacent and other illegal-content
// signals. Intentionally conservative; the point is to keep obvious abuse out
// of a free, unauthenticated funnel, not to be a content classifier.
const BANNED_PATTERNS = [
  /child\s*p[o0]rn/i,
  /\bcsam\b/i,
  /\bcp\b.*\b(links?|download)\b/i,
  /\bhitman\b/i,
  /\bhow to (make|build).*(bomb|explosive)/i,
];

export function validateTerm(term: string): { ok: true; value: string } | { ok: false; error: string } {
  const v = (term ?? "").trim();
  if (!v) return { ok: false, error: "Enter something to track." };
  if (v.length > MAX_TERM_LEN) return { ok: false, error: "That's too long." };
  if (BANNED_PATTERNS.some((re) => re.test(v))) {
    return { ok: false, error: "That query isn't allowed." };
  }
  return { ok: true, value: v };
}

export function validateCompiledQuery(
  query: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const v = (query ?? "").trim();
  if (!v) return { ok: false, error: "Query is empty." };
  if (v.length > MAX_QUERY_LEN) return { ok: false, error: "Query is too long." };
  if (BANNED_PATTERNS.some((re) => re.test(v))) {
    return { ok: false, error: "That query isn't allowed." };
  }
  return { ok: true, value: v };
}
