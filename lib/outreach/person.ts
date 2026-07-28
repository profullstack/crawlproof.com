// Read a person off a profile page.
//
// The link-following discovery elsewhere in this directory assumes a page
// points at a business's own site. A people directory does not: it publishes
// a name, a title and a location, and links only to itself. Following links
// there yields the directory's own footer, which is what it did before this
// existed.
//
// So this extracts the person as an entity instead. Structured data first,
// because a page that publishes schema.org Person markup has already told us
// exactly who it is about and nothing needs to be guessed from prose.
//
// The trap worth naming: a profile page usually carries several JSON-LD
// blocks, and the first is typically the site's own Organization. Taking
// `json[0]` gets the directory rather than the person — on the page this was
// built against, that is the difference between "Marc van Neerven, CTO" and
// "StackUp, a technology consultancy".

export type ExtractedPerson = {
  fullName: string;
  jobTitle: string | null;
  company: string | null;
  companySite: string | null;
  description: string | null;
  linkedinUrl: string | null;
  /** Other profiles found on the page, keyed by network. */
  socials: Record<string, string>;
  location: string | null;
  /** How we read it, so a weak guess can be told from structured data. */
  source: "json-ld" | "meta";
};

type Json = Record<string, unknown>;

function asString(v: unknown): string | null {
  if (typeof v === "string" && v.trim()) return v.trim();
  return null;
}

/** Flatten @graph containers and arrays into a list of candidate nodes. */
function flattenNodes(parsed: unknown): Json[] {
  const out: Json[] = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== "object") return;
    const obj = node as Json;
    out.push(obj);
    if (Array.isArray(obj["@graph"])) visit(obj["@graph"]);
  };
  visit(parsed);
  return out;
}

function typeOf(node: Json): string[] {
  const t = node["@type"];
  if (typeof t === "string") return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === "string");
  return [];
}

const LINKEDIN_RE = /^https?:\/\/([a-z]{2,3}\.)?linkedin\.com\//i;

/**
 * A clean LinkedIn profile URL, or null.
 *
 * Directories copy whatever the member pasted, and people paste the URL from
 * their own logged-in view — which is a settings page carrying session
 * tracking parameters, not a profile anyone else can open. Storing that is
 * worse than storing nothing: it looks like a working link right up until
 * someone clicks it.
 */
export function normalizeLinkedIn(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!/(^|\.)linkedin\.com$/i.test(url.hostname)) return null;
  // Only member and company profiles are addressable by other people.
  const m = url.pathname.match(/^\/(in|company|school)\/([^/]+)\/?$/i);
  if (!m) return null;
  return `https://www.linkedin.com/${m[1].toLowerCase()}/${m[2]}`;
}

/** Which network a profile URL belongs to, for the socials map. */
function networkOf(url: string): string | null {
  const patterns: [RegExp, string][] = [
    [/linkedin\.com/i, "linkedin"],
    [/(^|\/\/)(x|twitter)\.com/i, "x"],
    [/github\.com/i, "github"],
    [/mastodon|\.social/i, "mastodon"],
    [/bsky\.app/i, "bluesky"],
    [/youtube\.com/i, "youtube"],
    [/instagram\.com/i, "instagram"],
  ];
  for (const [re, name] of patterns) if (re.test(url)) return name;
  return null;
}

function personFromJsonLd(html: string): ExtractedPerson | null {
  const blocks = [
    ...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi),
  ].map((m) => m[1]);

  for (const raw of blocks) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.trim());
    } catch {
      continue;
    }
    for (const node of flattenNodes(parsed)) {
      // Every node is checked for Person rather than just the first block:
      // the site's own Organization normally comes first.
      if (!typeOf(node).includes("Person")) continue;
      const fullName = asString(node.name);
      if (!fullName) continue;

      const worksFor = node.worksFor;
      let company: string | null = null;
      let companySite: string | null = null;
      if (worksFor && typeof worksFor === "object") {
        const org = (Array.isArray(worksFor) ? worksFor[0] : worksFor) as Json;
        company = asString(org?.name);
        companySite = asString(org?.url);
      } else {
        company = asString(worksFor);
      }

      const sameAs = Array.isArray(node.sameAs)
        ? node.sameAs.filter((s): s is string => typeof s === "string")
        : typeof node.sameAs === "string"
          ? [node.sameAs]
          : [];

      const socials: Record<string, string> = {};
      let linkedinUrl: string | null = null;
      for (const url of sameAs) {
        if (LINKEDIN_RE.test(url) && !linkedinUrl) linkedinUrl = normalizeLinkedIn(url);
        const net = networkOf(url);
        if (net && !socials[net]) socials[net] = url;
      }

      const address = node.address;
      let location: string | null = null;
      if (address && typeof address === "object") {
        const a = address as Json;
        location =
          [asString(a.addressLocality), asString(a.addressRegion), asString(a.addressCountry)]
            .filter(Boolean)
            .join(", ") || null;
      } else {
        location = asString(address);
      }

      // Directories frequently write the whole thing into jobTitle — "Owner
      // and CTO at Artechra" — leaving worksFor empty. Splitting on " at "
      // recovers the employer that would otherwise be lost inside the role.
      const rawTitle = asString(node.jobTitle);
      let jobTitle = rawTitle;
      if (!company && rawTitle) {
        const m = rawTitle.match(/^(.*?)\s+at\s+(.+)$/i);
        if (m && m[1].trim() && m[2].trim()) {
          jobTitle = m[1].trim();
          company = m[2].trim();
        }
      }

      return {
        fullName,
        jobTitle,
        company,
        companySite,
        description: asString(node.description),
        linkedinUrl,
        socials,
        location,
        source: "json-ld",
      };
    }
  }
  return null;
}


/**
 * Words that never begin a person's name and reliably begin a heading.
 *
 * The meta fallback previously accepted "For Fractional CTOs" and "AI
 * Leadership Sprint" as people, because they are two-to-four capitalised
 * words like a name. A fabricated name reaches a real inbox addressed to
 * nobody, so the bar here is deliberately high: it is better to miss a
 * person than to invent one.
 */
const NOT_A_NAME_START =
  /^(for|the|a|an|our|your|my|why|how|what|when|top|best|about|meet|join|find|hire|get|introducing|welcome)$/i;

const NOT_A_NAME_WORD =
  /^(ctos?|ceos?|cfos?|founders?|members?|board|sprint|leadership|directory|guide|list|jobs?|careers?|services?|pricing|blog|news|team|home)$/i;

function looksLikePersonName(value: string): boolean {
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 4) return false;
  if (NOT_A_NAME_START.test(words[0])) return false;
  if (words.some((w) => NOT_A_NAME_WORD.test(w.replace(/[^A-Za-z]/g, "")))) return false;
  // Every word starts with a capital, allowing lowercase particles that real
  // names carry: van, de, der, bin, al.
  const PARTICLE = /^(van|von|de|del|della|der|den|di|da|du|la|le|bin|al|ibn|mac|mc|o')$/i;
  return words.every((w) => PARTICLE.test(w) || /^[A-Z]/.test(w));
}

/**
 * Does the page claim to be about a person at all?
 *
 * Without this, any well-formed two-word heading on a marketing page becomes
 * a contact. A profile URL or an og:type of profile is the page saying so
 * itself, which is a far better signal than the shape of its title.
 */
function hasProfileSignal(html: string, url: string): boolean {
  if (/\/(profile|people|person|member|members|team|u|author)\//i.test(url)) return true;
  const ogType = metaContent(html, "og:type");
  return ogType === "profile";
}

function metaContent(html: string, key: string): string | null {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']*)["']`,
    "i",
  );
  const alt = new RegExp(
    `<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${key}["']`,
    "i",
  );
  return asString(html.match(re)?.[1]) ?? asString(html.match(alt)?.[1]);
}

/**
 * Fallback for pages with no Person markup.
 *
 * og:title on a profile page is conventionally "Name - Title | Site". The
 * site segment after the final pipe is dropped, because it names the
 * directory rather than anyone's employer — treating it as a company is how
 * you end up with a thousand people who all work at "Fractional CTO
 * Directory".
 */
function personFromMeta(html: string, url: string): ExtractedPerson | null {
  const title = metaContent(html, "og:title") ?? asString(html.match(/<title[^>]*>([^<]*)/i)?.[1]);
  if (!title) return null;

  const withoutSite = title.split("|")[0].trim();
  const [namePart, ...rest] = withoutSite.split(/\s+[-–—]\s+/);
  const fullName = asString(namePart);
  if (!fullName) return null;
  if (!looksLikePersonName(fullName)) return null;
  if (!hasProfileSignal(html, url)) return null;

  return {
    fullName,
    jobTitle: rest.length ? rest.join(" - ").trim() : null,
    company: null,
    companySite: null,
    description: metaContent(html, "og:description") ?? metaContent(html, "description"),
    linkedinUrl: null,
    socials: {},
    location: null,
    source: "meta",
  };
}

/**
 * Extract the person a profile page is about, or null when it isn't about one.
 *
 * Returning null is the common and correct outcome — most pages are not
 * profiles, and inventing a person from a headline would put a fabricated
 * name into an email.
 */
export function extractPerson(html: string, url = ""): ExtractedPerson | null {
  return personFromJsonLd(html) ?? personFromMeta(html, url);
}

/**
 * The search query that stands the best chance of finding this person's
 * contact details.
 *
 * Name alone is ambiguous for anyone without an unusual one, so the employer
 * or job title is included as a discriminator. Quoting the name keeps the
 * engine from returning everyone who shares a surname.
 */
export function personSearchQuery(person: ExtractedPerson): string {
  const parts = [`"${person.fullName}"`];
  if (person.company) parts.push(`"${person.company}"`);
  else if (person.jobTitle) parts.push(person.jobTitle);
  parts.push("(email OR contact)");
  return parts.join(" ");
}
