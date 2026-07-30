/**
 * Recipient filtering for broadcast sends.
 *
 * Resend rejects reserved/documentation domains outright with a 422
 * ("Invalid `to` field. Please use our testing email address instead of domains like
 * `example.com`"), and sendBulk goes through Resend's batch endpoint, so a single bad
 * address fails every address in its batch of 100 alongside it. Seed and test rows are
 * therefore dropped before the send rather than after it.
 */

/** Reserved second-level domains (RFC 2606) that no real mailbox lives on. */
const RESERVED_DOMAINS = new Set([
  "example.com",
  "example.net",
  "example.org",
  "example.edu",
  "test.com",
  "test.net",
  "test.org",
  "domain.com",
  "email.com",
  "yourdomain.com",
  "mydomain.com",
]);

/** Reserved TLDs (RFC 2606 / RFC 6761) that can never receive mail. */
const RESERVED_TLDS = [".test", ".example", ".invalid", ".localhost", ".local"];

/** Deliberately loose: real addresses vary wildly, we only reject clear nonsense. */
const SHAPE =
  /^[^\s@,;:<>()[\]\\"]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

/** True when the address is worth handing to Resend. */
export function isSendableEmail(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const email = raw.trim().toLowerCase();
  if (!SHAPE.test(email)) return false;

  const domain = email.slice(email.lastIndexOf("@") + 1);
  if (RESERVED_DOMAINS.has(domain)) return false;
  if (RESERVED_TLDS.some((tld) => domain.endsWith(tld))) return false;
  if (!domain.includes(".")) return false;

  return true;
}

/** Normalises, de-duplicates and filters a recipient list, preserving first-seen order. */
export function sendableEmails(
  emails: Iterable<string | null | undefined>,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of emails) {
    if (!isSendableEmail(raw)) continue;
    const email = (raw as string).trim().toLowerCase();
    if (seen.has(email)) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}
