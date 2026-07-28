// One verifiable sentence about the recipient, read off their own homepage.
//
// A cold email that opens with a specific, checkable observation about the
// reader outperforms one that opens with the sender. The custom-pitch prompt
// originally forbade saying anything about the recipient at all, which was
// the right instinct — without research, "I loved your work" is a fabrication
// — but it banned the strongest opening available.
//
// This supplies the research instead of removing the guard. Only what the
// site says about itself in its own title and description is used: no
// inference, no summarising of prose, nothing the reader could not verify by
// looking at their own homepage. If the site says nothing useful, this
// returns null and the draft opens some other way rather than guessing.

const MAX_DESCRIPTION_CHARS = 220;

/** Boilerplate that describes a template rather than a business. */
const USELESS_DESCRIPTION =
  /^(home|homepage|welcome|index|untitled|new page|coming soon|site|website|default|just another wordpress site)\b/i;

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function meta(html: string, key: string): string | null {
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${key}["']`, "i"),
  ];
  for (const re of patterns) {
    const v = html.match(re)?.[1];
    if (v && v.trim()) return decodeEntities(v);
  }
  return null;
}

export type RecipientContext = {
  /** What the site says it does, in its own words. */
  selfDescription: string;
  /** Which tag it came from, so the claim is auditable. */
  source: "og:description" | "meta description" | "og:title" | "title";
};

/**
 * Read what a site says about itself.
 *
 * Descriptions are preferred over titles because a title is often just the
 * brand name, which supports no observation worth making. A title is only
 * used when it carries a tagline — a bare brand name tells the drafter
 * nothing it did not already have from the domain.
 */
export function extractRecipientContext(html: string): RecipientContext | null {
  const candidates: [string | null, RecipientContext["source"]][] = [
    [meta(html, "og:description"), "og:description"],
    [meta(html, "description"), "meta description"],
    [meta(html, "og:title"), "og:title"],
    [decodeEntities(html.match(/<title[^>]*>([^<]*)/i)?.[1] ?? ""), "title"],
  ];

  for (const [raw, source] of candidates) {
    if (!raw) continue;
    const value = raw.slice(0, MAX_DESCRIPTION_CHARS).trim();
    if (value.length < 20) continue;
    if (USELESS_DESCRIPTION.test(value)) continue;
    // A title is only worth using when it says more than the brand name.
    if ((source === "title" || source === "og:title") && !/[-–—|:,]/.test(value)) continue;
    return { selfDescription: value, source };
  }
  return null;
}

/**
 * The prompt line that lets a draft open with a real observation.
 *
 * Phrased as a quotation with an explicit boundary, because the failure mode
 * is not the model inventing a company — it is the model extrapolating from
 * one accurate sentence into a paragraph of assumed detail about their
 * roadmap, their customers, and their problems.
 */
export function recipientContextPrompt(ctx: RecipientContext | null, host: string): string {
  if (!ctx) {
    return `Recipient: someone at ${host}. Nothing is known about them beyond the domain — do not characterise their work, their site, or their needs as fact.`;
  }
  return [
    `Recipient: someone at ${host}.`,
    `Their site describes itself as: "${ctx.selfDescription}"`,
    `You may refer to that description, and only that. It is the single thing you know about them.`,
    `Do not extend it: nothing about their customers, their traffic, their roadmap, their problems, or how well any of it is going.`,
    `A short, accurate observation drawn from it is a strong opening. Flattery is not — do not say you love, admire, or are impressed by their work.`,
  ].join(" ");
}

/**
 * Fetch a prospect's homepage and read what it says about itself.
 *
 * Plain fetch only, and failures are swallowed. This exists to improve an
 * opening line; it must never be the reason a draft doesn't get written, and
 * it is not worth a browser render.
 */
export async function loadRecipientContext(host: string): Promise<RecipientContext | null> {
  const clean = host.trim().toLowerCase().replace(/^www\./, "");
  if (!clean || !clean.includes(".")) return null;
  for (const url of [`https://${clean}/`, `https://www.${clean}/`]) {
    try {
      const res = await fetch(url, {
        headers: { "user-agent": "CrawlProofOutreach/1.0 (+https://crawlproof.com)" },
        signal: AbortSignal.timeout(8_000),
        redirect: "follow",
      });
      if (!res.ok) continue;
      const ctx = extractRecipientContext(await res.text());
      if (ctx) return ctx;
    } catch {
      // Next candidate, or none.
    }
  }
  return null;
}
