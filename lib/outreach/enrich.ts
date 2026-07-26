// Contact enrichment — turn a domain into someone you can actually write to.
//
// Zero API cost: everything is read from the prospect's own public pages.
// That is a deliberate constraint, not a limitation to route around. A
// purchased B2B record is stale the day you buy it, and a bounced cold email
// costs more sending reputation than the lead was worth; the address a
// business publishes on its own contact page is, by construction, the one it
// wants strangers to use.

import * as cheerio from "cheerio";
import { promises as dns } from "node:dns";
import net from "node:net";
import {
  discoverContactEmails,
  isNeverContactMailbox,
  normalizeEmail,
  normalizeHost,
  rankContacts,
  type ContactCandidate,
} from "./cold";

export type SocialLinks = {
  linkedin?: string;
  x?: string;
  facebook?: string;
  instagram?: string;
  youtube?: string;
  github?: string;
};

export type EnrichedContact = {
  host: string;
  fetchedUrls: string[];
  title: string | null;
  description: string | null;
  emails: ContactCandidate[];
  phones: string[];
  address: string | null;
  socials: SocialLinks;
};

/** Pages that carry contact details, in the order they usually carry them. */
const ENRICH_PATHS = ["/", "/contact", "/contact-us", "/about", "/about-us", "/impressum", "/legal"];

// North-American and international shapes. Deliberately loose on separators,
// strict on length, because the common false positive is a date or a price.
const PHONE_RE =
  /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{2,4}[\s.-]\d{2,4}[\s.-]?\d{2,4}(?:[\s.-]?\d{2,4})?/g;

const SOCIAL_PATTERNS: Array<{ key: keyof SocialLinks; re: RegExp }> = [
  { key: "linkedin", re: /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(?:company|in|school)\/[^"'\s<>]+/i },
  { key: "x", re: /https?:\/\/(?:www\.)?(?:twitter|x)\.com\/(?!share|intent)[^"'\s<>/]+/i },
  { key: "facebook", re: /https?:\/\/(?:www\.)?facebook\.com\/(?!sharer|tr\?)[^"'\s<>]+/i },
  { key: "instagram", re: /https?:\/\/(?:www\.)?instagram\.com\/[^"'\s<>/]+/i },
  { key: "youtube", re: /https?:\/\/(?:www\.)?youtube\.com\/(?:@|c\/|channel\/|user\/)[^"'\s<>]+/i },
  { key: "github", re: /https?:\/\/(?:www\.)?github\.com\/[^"'\s<>/]+/i },
];

export function extractPhones(text: string): string[] {
  const out = new Set<string>();
  for (const match of text.matchAll(PHONE_RE)) {
    const raw = match[0].trim();
    const digits = raw.replace(/\D/g, "");
    if (digits.length > 15) continue;

    // Everything below is a shape that satisfies "digits with separators" and
    // is never a phone number. Each one showed up in real page text during
    // testing: an ISO date, a Japanese postal code, a version/IP triple.
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) continue;
    if (/^\d{1,3}(\.\d{1,3}){2,}$/.test(raw)) continue;
    if (/^(19|20)\d{2}$/.test(digits)) continue;

    // A real number is either 10+ digits (national), or international with a
    // leading +, or carries an explicit (area code). A bare 7-digit run with
    // no country or area context is a postal code far more often than a
    // phone number, and mailing the wrong thing to a prospect is worse than
    // missing one.
    const international = raw.trim().startsWith("+") && digits.length >= 8;
    const hasAreaCode = /\(\d{2,4}\)/.test(raw);
    if (!international && !hasAreaCode && digits.length < 10) continue;

    out.add(raw.replace(/\s+/g, " "));
    if (out.size >= 5) break;
  }
  return [...out];
}

export function extractSocials(html: string): SocialLinks {
  const socials: SocialLinks = {};
  for (const { key, re } of SOCIAL_PATTERNS) {
    const match = html.match(re);
    if (match) socials[key] = match[0].replace(/[?&#].*$/, "");
  }
  return socials;
}

/**
 * Postal address. Schema.org PostalAddress first — when a site publishes
 * structured data it is right, and the regex fallback on prose is a guess.
 */
export function extractAddress(html: string, $?: cheerio.CheerioAPI): string | null {
  const ld = html.match(/"address"\s*:\s*\{[^}]*\}/i);
  if (ld) {
    try {
      const obj = JSON.parse(`{${ld[0]}}`) as {
        address?: Record<string, string>;
      };
      const a = obj.address ?? {};
      const parts = [a.streetAddress, a.addressLocality, a.addressRegion, a.postalCode, a.addressCountry]
        .filter(Boolean)
        .join(", ");
      if (parts) return parts.slice(0, 200);
    } catch {
      // Malformed JSON-LD is common; fall through to the markup check.
    }
  }
  const doc = $ ?? cheerio.load(html);
  const addressEl = doc("address").first().text().replace(/\s+/g, " ").trim();
  if (addressEl && addressEl.length > 8) return addressEl.slice(0, 200);

  const text = doc("body").text().replace(/\s+/g, " ");
  const street = text.match(
    /\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,4}\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Suite|Ste|Way|Court|Ct|Parkway|Pkwy)\b[^.]{0,60}/i,
  );
  return street ? street[0].trim().slice(0, 200) : null;
}

export function enrichFromHtml(input: { html: string; url: string; host: string }): Omit<EnrichedContact, "fetchedUrls" | "host"> {
  const $ = cheerio.load(input.html);
  const title = $("title").first().text().trim() || null;
  const description =
    $('meta[name="description"]').attr("content")?.trim() ||
    $('meta[property="og:description"]').attr("content")?.trim() ||
    null;
  const bodyText = $("body").text();

  return {
    title: title ? title.slice(0, 200) : null,
    description: description ? description.slice(0, 300) : null,
    emails: discoverContactEmails(input.html, input.host),
    phones: extractPhones(bodyText),
    address: extractAddress(input.html, $),
    socials: extractSocials(input.html),
  };
}

/**
 * Fetch a site's public pages and merge what they say about how to reach the
 * business. Stops as soon as it has an on-domain address and a phone number
 * — there is no reason to crawl a stranger's whole site.
 */
export async function enrichContact(input: {
  url: string;
  maxPages?: number;
}): Promise<{ contact: EnrichedContact; errors: string[] }> {
  const host = normalizeHost(input.url);
  const errors: string[] = [];
  const contact: EnrichedContact = {
    host,
    fetchedUrls: [],
    title: null,
    description: null,
    emails: [],
    phones: [],
    address: null,
    socials: {},
  };

  const explicitPath = (() => {
    try {
      const p = new URL(/^https?:\/\//.test(input.url) ? input.url : `https://${input.url}`).pathname;
      return p && p !== "/" ? p : null;
    } catch {
      return null;
    }
  })();
  const paths = explicitPath ? [explicitPath, ...ENRICH_PATHS] : ENRICH_PATHS;
  const maxPages = Math.min(input.maxPages ?? 3, ENRICH_PATHS.length + 1);

  for (const path of paths) {
    if (contact.fetchedUrls.length >= maxPages) break;
    const url = `https://${host}${path}`;
    try {
      const res = await fetch(url, {
        headers: { "user-agent": "CrawlProofOutreach/1.0 (+https://crawlproof.com)" },
        signal: AbortSignal.timeout(10_000),
        redirect: "follow",
      });
      if (!res.ok) continue;
      const html = await res.text();
      contact.fetchedUrls.push(url);

      const page = enrichFromHtml({ html, url, host });
      contact.title ??= page.title;
      contact.description ??= page.description;
      contact.address ??= page.address;
      contact.emails = rankContacts([...contact.emails, ...page.emails]);
      contact.phones = [...new Set([...contact.phones, ...page.phones])].slice(0, 5);
      contact.socials = { ...page.socials, ...contact.socials };

      if (contact.emails.some((e) => e.sameDomain) && contact.phones.length) break;
    } catch (err) {
      errors.push(`${url}: ${err instanceof Error ? err.message : "fetch failed"}`);
    }
  }

  // Dedupe while preserving rank.
  const seen = new Set<string>();
  contact.emails = contact.emails.filter((e) => !seen.has(e.email) && seen.add(e.email));
  return { contact, errors };
}

// -------------------------------------------------------------- email_find

export type EmailGuess = {
  email: string;
  pattern: string;
  /** 0-100. Pattern frequency in the wild, adjusted by what we could verify. */
  confidence: number;
  verification: "accepted" | "rejected" | "catch-all" | "unverified";
};

/**
 * Ordered by how common each pattern actually is at small and mid-size
 * companies. The order is the whole value of this function: guessing
 * first.last@ before first@ inverts the hit rate.
 */
export const EMAIL_PATTERNS: Array<{ name: string; build: (f: string, l: string) => string }> = [
  { name: "first.last", build: (f, l) => `${f}.${l}` },
  { name: "first", build: (f) => f },
  { name: "flast", build: (f, l) => `${f[0]}${l}` },
  { name: "firstl", build: (f, l) => `${f}${l[0]}` },
  { name: "first_last", build: (f, l) => `${f}_${l}` },
  { name: "firstlast", build: (f, l) => `${f}${l}` },
  { name: "last.first", build: (f, l) => `${l}.${f}` },
  { name: "f.last", build: (f, l) => `${f[0]}.${l}` },
  { name: "last", build: (_f, l) => l },
];

const BASE_CONFIDENCE = [72, 60, 55, 45, 40, 38, 25, 30, 20];

function slug(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

export function candidateEmails(input: {
  firstName: string;
  lastName: string;
  domain: string;
}): EmailGuess[] {
  const first = slug(input.firstName);
  const last = slug(input.lastName);
  const domain = normalizeHost(input.domain);
  if (!first || !last || !domain) return [];

  const seen = new Set<string>();
  const out: EmailGuess[] = [];
  EMAIL_PATTERNS.forEach((p, i) => {
    const local = p.build(first, last);
    const email = normalizeEmail(`${local}@${domain}`);
    if (seen.has(email) || isNeverContactMailbox(email)) return;
    seen.add(email);
    out.push({
      email,
      pattern: p.name,
      confidence: BASE_CONFIDENCE[i] ?? 20,
      verification: "unverified",
    });
  });
  return out;
}

export async function mxHost(domain: string): Promise<string | null> {
  try {
    const records = await dns.resolveMx(normalizeHost(domain));
    if (!records.length) return null;
    return records.sort((a, b) => a.priority - b.priority)[0]?.exchange ?? null;
  } catch {
    return null;
  }
}

/**
 * SMTP RCPT-TO probe.
 *
 * Honest caveat, because this is the part every "email finder" oversells:
 * most cloud hosts (Railway included) block outbound port 25, and the large
 * mail providers answer 250 to everything. So a positive is weak evidence, a
 * "catch-all" is no evidence, and a blocked port yields "unverified" rather
 * than a guess dressed up as a fact. It never sends a message — the session
 * is aborted before DATA.
 */
export async function smtpProbe(input: {
  email: string;
  mx: string;
  fromAddress: string;
  timeoutMs?: number;
}): Promise<"accepted" | "rejected" | "unverified"> {
  return new Promise((resolve) => {
    const timeout = input.timeoutMs ?? 6_000;
    let settled = false;
    const done = (r: "accepted" | "rejected" | "unverified") => {
      if (settled) return;
      settled = true;
      try {
        socket.write("QUIT\r\n");
        socket.destroy();
      } catch {
        // Already gone.
      }
      resolve(r);
    };

    const socket = net.createConnection({ host: input.mx, port: 25, timeout });
    let stage = 0;
    let buffer = "";

    socket.on("timeout", () => done("unverified"));
    socket.on("error", () => done("unverified"));
    socket.on("close", () => done("unverified"));
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (!buffer.endsWith("\r\n")) return;
      const code = Number(buffer.trim().slice(-buffer.trim().length).match(/^(\d{3})/m)?.[1] ?? 0);
      const lines = buffer.trim().split("\r\n");
      const lastCode = Number(lines[lines.length - 1]?.slice(0, 3) ?? code);
      buffer = "";

      if (stage === 0) {
        if (lastCode !== 220) return done("unverified");
        socket.write(`HELO ${normalizeHost(input.fromAddress.split("@")[1] ?? "crawlproof.com")}\r\n`);
        stage = 1;
      } else if (stage === 1) {
        if (lastCode !== 250) return done("unverified");
        socket.write(`MAIL FROM:<${input.fromAddress}>\r\n`);
        stage = 2;
      } else if (stage === 2) {
        if (lastCode !== 250) return done("unverified");
        socket.write(`RCPT TO:<${input.email}>\r\n`);
        stage = 3;
      } else {
        if (lastCode === 250 || lastCode === 251) return done("accepted");
        if (lastCode >= 500 && lastCode < 600) return done("rejected");
        done("unverified");
      }
    });
  });
}

export async function findEmail(input: {
  firstName: string;
  lastName: string;
  domain: string;
  fromAddress: string;
  verify?: boolean;
}): Promise<{ guesses: EmailGuess[]; mx: string | null; catchAll: boolean; note: string }> {
  const guesses = candidateEmails(input);
  const mx = await mxHost(input.domain);
  if (!mx) {
    return {
      guesses,
      mx: null,
      catchAll: false,
      note: "No MX record — this domain does not receive mail at all. Do not send.",
    };
  }
  if (input.verify === false) {
    return { guesses, mx, catchAll: false, note: "Verification skipped; confidence is pattern frequency only." };
  }

  // Probe an address nobody owns first. If the server accepts it, it accepts
  // everything, and every later "accepted" means nothing.
  const catchAllProbe = await smtpProbe({
    email: `crawlproof-probe-${Date.now().toString(36)}@${normalizeHost(input.domain)}`,
    mx,
    fromAddress: input.fromAddress,
  });
  if (catchAllProbe === "accepted") {
    return {
      guesses,
      mx,
      catchAll: true,
      note: "Catch-all domain: the server accepts any address, so SMTP verification proves nothing here. Ranking is pattern frequency only.",
    };
  }
  if (catchAllProbe === "unverified") {
    return {
      guesses,
      mx,
      catchAll: false,
      note: "SMTP port 25 is unreachable from this host (normal on cloud platforms), so nothing could be verified. Ranking is pattern frequency only.",
    };
  }

  const verified: EmailGuess[] = [];
  for (const guess of guesses.slice(0, 6)) {
    const result = await smtpProbe({ email: guess.email, mx, fromAddress: input.fromAddress });
    verified.push({
      ...guess,
      verification: result,
      confidence:
        result === "accepted"
          ? Math.min(97, guess.confidence + 30)
          : result === "rejected"
            ? 0
            : guess.confidence,
    });
    if (result === "accepted") break;
  }
  const rest = guesses.slice(verified.length);
  const all = [...verified, ...rest]
    .filter((g) => g.verification !== "rejected")
    .sort((a, b) => b.confidence - a.confidence);

  return {
    guesses: all,
    mx,
    catchAll: false,
    note: all[0]?.verification === "accepted" ? "Top result was accepted by the mail server." : "Nothing confirmed; ranking is pattern frequency.",
  };
}

// ------------------------------------------------------------------ export

export type ExportableLead = Record<string, unknown>;

/** RFC 4180 quoting — a business name with a comma otherwise shifts a column. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = Array.isArray(value) ? value.join(" | ") : typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function leadsToCsv(leads: ExportableLead[]): string {
  if (!leads.length) return "";
  const columns = [...new Set(leads.flatMap((l) => Object.keys(l)))];
  const header = columns.map(csvCell).join(",");
  const rows = leads.map((l) => columns.map((c) => csvCell(l[c])).join(","));
  return [header, ...rows].join("\n");
}

export function leadsToJson(leads: ExportableLead[]): string {
  return JSON.stringify(leads, null, 2);
}
