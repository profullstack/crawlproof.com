// Feed ads — a creative rendered as a syndication item.
//
// The consumer here is neither a browser nor a TTY: it is somebody else's RSS,
// Atom or JSON Feed document, being built by a static site generator, a CMS, or
// a directory like rssamplifier.com. So the unit is not a box with pixels, it
// is an *item* — a title, a link, a date, an identity, and a body — spliced
// into a river of real posts every ~10 entries.
//
// Three constraints drive every decision below, and none of them apply to the
// web or terminal formats:
//
//  1. **No namespaces.** A fragment is pasted inside a `<channel>` whose root
//     element we did not write. If we emit `<dc:creator>` or `<media:content>`
//     and the publisher's `<rss>` never declared that prefix, the document is
//     not merely ugly — it is not well-formed, and every reader drops the whole
//     feed rather than the one item. So the RSS fragment uses core RSS 2.0
//     elements only, and the Atom fragment uses core Atom elements only (which
//     need no prefix: they inherit the default namespace from `<feed>`).
//
//  2. **No CSS.** Feed readers strip `<style>` blocks outright and most strip
//     `style=` attributes too. The markup therefore has to read correctly with
//     zero styling applied — semantic elements carrying the hierarchy, never a
//     layout that collapses into a heap once the attributes are gone.
//
//  3. **A stable identity.** `<guid>` is what tells a reader "you have seen
//     this". Mint a fresh one per fetch and the ad resurfaces as unread on
//     every rebuild, which is how a feed gets unsubscribed from. Freeze it
//     forever and the advertiser reaches each subscriber exactly once. Neither
//     is right, so the identity is periodic — see `adGuid`.
//
// Pure and client-safe (no server-only imports) so an editor preview renders
// exactly what the endpoint serves — the same rule ./formats and ./terminal
// follow.

import { FEED_FORMAT_ID, FEED_ITEM_LABEL, type AdCreative } from "./formats";
import { renderCreativeText } from "./terminal";

// The format id and its caption live in ./formats, which is the one module that
// names a format — re-exported here so a call site working with feed ads has a
// single import rather than two.
export { FEED_FORMAT_ID, FEED_ITEM_LABEL };

/**
 * The wire shapes `/api/ads/feed` can return.
 *
 * `rss`/`atom`/`json` are ready-to-splice items. `html`/`markdown`/`text` are
 * just the *body*, for a publisher whose feed builder wants to own the item
 * envelope. `fields` is the raw material for anyone templating it themselves —
 * it is also the integration contract rssamplifier.com consumes, precisely so
 * that its own renderers keep doing its own escaping.
 */
export const FEED_SHAPES = ["rss", "atom", "json", "html", "markdown", "text", "fields"] as const;
export type FeedShape = (typeof FEED_SHAPES)[number];

/**
 * How much of the ad the body carries.
 *
 * `text` is the long thin one — a single sponsored line that reads as a line of
 * the feed rather than an interruption of it. `card` adds the artwork and puts
 * the call to action on its own line. `terminal` is the ASCII box, for feeds
 * whose readers are developers.
 *
 * `article` is the long form: the campaign's editorial summary rendered as real
 * paragraphs, for a placement that sits inside somebody's writing — a sponsored
 * section of a blog post, or a feed whose items are read rather than scanned.
 * It is the only style that needs data beyond the creative (see
 * `FeedItemInput.summary`), and it degrades to `card` when a campaign has no
 * prose, because an "article" with one line in it is just a worse card.
 */
export const FEED_STYLES = ["text", "card", "terminal", "article"] as const;
export type FeedStyle = (typeof FEED_STYLES)[number];

/** How the item's identity rotates. See `adGuid`. */
export const GUID_MODES = ["daily", "weekly", "fill", "static"] as const;
export type GuidMode = (typeof GUID_MODES)[number];

/** Default disclosure word. Configurable in wording, never removable. */
export const DEFAULT_LABEL = "Sponsored";
/** Attribution line, the feed twin of the terminal box's bottom border. */
export const ATTRIBUTION = "Ads by CrawlProof";
export const ATTRIBUTION_URL = "https://crawlproof.com/ads";

/**
 * `rel` on every link we emit.
 *
 * `sponsored` and `nofollow` are not decoration. A feed ad is a paid link that
 * gets copied verbatim into every aggregator that mirrors the feed, which is
 * the exact shape of a link scheme — leaving them off would put the publisher's
 * feed, and ours, at risk of a manual action. `noopener` is the ordinary
 * defence for `target="_blank"`.
 */
const LINK_REL = "sponsored nofollow noopener";

/**
 * The control characters XML 1.0 forbids outright.
 *
 * There is no escape for them: a document containing one does not degrade, it
 * fails to parse. Ad copy reaches us through an LLM and a form, so it is
 * stripped rather than trusted.
 */
// eslint-disable-next-line no-control-regex
const XML_ILLEGAL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

export function isFeedShape(v: string | null | undefined): v is FeedShape {
  return !!v && (FEED_SHAPES as readonly string[]).includes(v);
}

export function isFeedStyle(v: string | null | undefined): v is FeedStyle {
  return !!v && (FEED_STYLES as readonly string[]).includes(v);
}

export function isGuidMode(v: string | null | undefined): v is GuidMode {
  return !!v && (GUID_MODES as readonly string[]).includes(v);
}

// ------------------------------------------------------------------ escaping

/** Escape for XML text and attributes alike, dropping the illegal controls. */
export function esc(v: unknown): string {
  return String(v ?? "")
    .replace(XML_ILLEGAL, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Wrap a body in CDATA, which is how essentially every feed carries HTML.
 *
 * The one sequence CDATA cannot contain is its own terminator, and there is no
 * escape for it — the only legal move is to close the section and open a new
 * one around the `>`. Our own markup never produces `]]>`, but the copy inside
 * it is advertiser-authored, so this is a correctness guard rather than a
 * theoretical one.
 */
export function cdata(html: string): string {
  const safe = String(html ?? "").replace(XML_ILLEGAL, "");
  return `<![CDATA[${safe.replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
}

/** Collapse copy onto one line and trim it. Titles and summaries are one line. */
export function oneLine(v: unknown): string {
  return String(v ?? "")
    .replace(XML_ILLEGAL, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A call to action with any trailing arrow removed.
 *
 * Advertiser copy frequently already ends in one ("Try it free →"), and we add
 * our own, so without this the rendered unit reads "Try it free → →".
 */
export function ctaLabel(v: unknown): string {
  return oneLine(v).replace(/\s*(->|→|>|:)\s*$/, "").trim() || "Learn more";
}

// -------------------------------------------------------------------- identity

/**
 * The item's identity, and the date that goes with it.
 *
 * A feed ad is read by software that remembers what it has already shown, and
 * the guid is the whole of that memory. The rotation period is therefore a
 * product decision rather than an implementation detail:
 *
 * - `daily` (the default) — one sponsored item per slot per UTC day. A reader
 *   polling every 15 minutes sees the ad once; a publisher rebuilding hourly
 *   does not spam anybody. This is the polite setting and should stay default.
 * - `weekly` — the same, at a week's cadence, for a low-volume feed where a
 *   daily ad would outnumber the posts.
 * - `fill` — unique per fetch. Every rebuild is a new unread item. Correct only
 *   for a high-churn river where the ad would otherwise scroll away unseen,
 *   and genuinely rude anywhere else.
 * - `static` — one identity, forever. The ad is seen once per subscriber and
 *   never resurfaces. For a publisher who wants a permanent, unobtrusive
 *   sponsor line and does not care about repeat delivery.
 *
 * The key is namespaced by **slot**, not by campaign, and that is deliberate:
 * the campaign rotates on every fill, so keying by it would defeat the whole
 * mechanism — a daily guid would change several times an hour. Keying by slot
 * means "today's sponsor slot for this publisher", whichever advertiser won it.
 *
 * The consequence, which callers need to know: within a period the guid is
 * fixed while the creative behind it is not, so a reader keeps whichever fill
 * it saw first. Rebuilding more often than the period buys the advertiser
 * nothing, which is why the fetcher on the consuming side should cache.
 *
 * `position` is what keeps a multi-ad request honest. A 50-item feed asking for
 * three ads gets three fills, and under a periodic mode all three would
 * otherwise resolve to the same daily key — one identity for three different
 * items, which is the one thing a guid may never be. Numbering them by their
 * place in the feed also keeps each position's identity stable across rebuilds,
 * so the ad two thirds of the way down stays the same item it was an hour ago.
 *
 * @param mode rotation period
 * @param ctx slot the ad filled, the fill's impression id, its position, "now"
 * @returns the tag: URI to use as guid/id, and the date to publish it under
 */
export function adGuid(
  mode: GuidMode,
  ctx: { slotId: string; impressionId: string; position?: number; now?: Date },
): { guid: string; published: Date } {
  const now = ctx.now ?? new Date();
  const slot = String(ctx.slotId || "default").replace(/[^\w.:-]/g, "");
  // Position 0 adds nothing to the key, so a single-ad request keeps exactly
  // the identity it had before positions existed — an established subscriber
  // must not see every ad resurface because we started numbering them.
  const at = Number.isFinite(ctx.position) && Number(ctx.position) > 0 ? `/${Number(ctx.position)}` : "";

  if (mode === "fill") {
    return { guid: tagUri(`ad/${slot}/fill/${ctx.impressionId}`), published: now };
  }
  if (mode === "static") {
    return { guid: tagUri(`ad/${slot}${at}`), published: now };
  }

  const start = mode === "weekly" ? startOfUtcWeek(now) : startOfUtcDay(now);
  const key = start.toISOString().slice(0, 10);
  return {
    guid: tagUri(`ad/${slot}/${mode === "weekly" ? "w" : "d"}/${key}${at}`),
    published: start,
  };
}

/**
 * A `tag:` URI, which is what an Atom `<id>` has to be — an IRI, not a URL.
 *
 * The date is the authority date RFC 4151 requires, and it is a constant on
 * purpose: it identifies *when we took ownership of the naming scheme*, not
 * when the item was made, so changing it would silently re-identify every ad
 * ever emitted and resurface all of them as unread.
 */
function tagUri(path: string): string {
  return `tag:crawlproof.com,2026:${path}`;
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Monday 00:00 UTC of the week containing `d`. */
function startOfUtcWeek(d: Date): Date {
  const day = startOfUtcDay(d);
  // getUTCDay() is 0 for Sunday, which is 6 days into an ISO week, not 0.
  const offset = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - offset * 86_400_000);
}

/** Day and month names — RFC 822 dates are English regardless of locale. */
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * A Date as RFC 822, which is what an RSS `<pubDate>` is.
 *
 * Hand-built rather than `toUTCString()`: that method is specified to produce
 * this format, but it is also the one place runtimes are free to differ on the
 * day-name abbreviations, and a reader that cannot parse pubDate does not fail
 * loudly — it sorts the publisher's whole feed wrongly.
 */
export function rfc822(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${DAYS[d.getUTCDay()]}, ${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} GMT`
  );
}

// ------------------------------------------------------- client classification

/**
 * Crawlers that must stay off paid inventory even on a feed endpoint.
 *
 * Deliberately checked *after* FEED_RE below. Several legitimate aggregators
 * put a bot-ish word in their user agent — Feedly's fetcher advertises itself
 * as "like FeedFetcher-Google" — and bucketing those as crawlers would mean the
 * biggest feed readers on the internet could never fill a paid slot.
 */
const CRAWLER_RE = /googlebot|bingbot|yandexbot|ahrefs|semrush|petalbot|dotbot|mj12|headless|screenshot|archive\.org|ia_archiver/i;

/**
 * The real audience for a feed ad: whatever builds or fetches a feed document.
 *
 * That is almost never a browser. It is a static site generator running in CI,
 * a CMS rendering `/feed.xml`, a server-side aggregator, or a reader's polling
 * fetcher — and every one of them identifies as an HTTP library. The generic
 * tracker (lib/tracker/device) buckets all of those as "bot", which is right
 * for a web page and exactly wrong here: `isBotDevice` sends bots to the
 * unmetered house ad, so without this a feed slot would serve nothing but house
 * ads and never earn a cent. This is the same trap `terminalDeviceType` exists
 * to avoid, for the same reason.
 */
const FEED_RE =
  /feed|rss|atom|syndicat|feedly|inoreader|newsblur|miniflux|freshrss|tt-?rss|netnewswire|reeder|feedbin|newsboat|liferea|akregator|thunderbird|granary|curl|wget|httpie|python-requests|node-fetch|undici|go-http|okhttp|libwww|lwp|axios|got \(|guzzle|faraday|hugo|eleventy|jekyll|gatsby|astro|next\.js/i;

/**
 * Device bucket for a feed-ad request.
 *
 * Returns "bot" for real crawlers, "feed" for feed builders and readers (and
 * for a missing user agent, which server-side fetchers routinely omit), and
 * null to let the caller fall back to its own classification.
 */
export function feedDeviceType(userAgent: string | null | undefined): string | null {
  const ua = (userAgent ?? "").trim();
  if (!ua) return "feed";
  if (FEED_RE.test(ua)) return "feed";
  if (CRAWLER_RE.test(ua)) return "bot";
  return null;
}

// ---------------------------------------------------------------------- bodies

export type FeedRenderOpts = {
  /** Body style. Default 'text' — the long thin one. */
  style?: FeedStyle;
  /** Disclosure wording. Blank falls back to 'Sponsored'; it is never dropped. */
  label?: string;
  /** Identity rotation. Default 'daily'. */
  guidMode?: GuidMode;
  /** Box width for the terminal style. */
  cols?: number;
  /**
   * The campaign's editorial prose. `card` prefers the short form over the
   * creative's one-line body; `article` is built from the long form. Threaded
   * through opts rather than the creative because it belongs to the campaign,
   * not to a format — every creative of a campaign shares one.
   */
  summary?: { short: string | null; long: string | null } | null;
  /** Clock injection, for tests. */
  now?: Date;
};

/** Paragraphs of a long summary, cleaned. Empty when there is no prose. */
export function summaryParagraphs(long: string | null | undefined): string[] {
  return String(long ?? "")
    .split(/\n\s*\n/)
    .map((p) => oneLine(p))
    .filter(Boolean);
}

/** Disclosure wording, sanitised. Empty input falls back rather than removing it. */
export function labelText(v: string | null | undefined): string {
  const s = oneLine(v).replace(/[[\]]/g, "").slice(0, 24);
  return s || DEFAULT_LABEL;
}

/**
 * The item title.
 *
 * The disclosure stays in the title, because a great many readers show titles
 * in a list and bodies only on click — an item whose sponsorship is disclosed
 * exclusively in the body is, for those readers, an undisclosed one.
 *
 * But it goes at the *end*. A leading "[Sponsored]" is the first thing the eye
 * lands on in a list of headlines, and it reads as a subject-line prefix on
 * spam, so the item is skipped before the offer is ever read. Trailing, the
 * headline gets to say what it is and the label still travels everywhere the
 * title travels. Nothing is hidden: this is the same word, in the same field,
 * and `<category>` carries it machine-readably besides.
 */
export function feedTitle(creative: AdCreative, label = DEFAULT_LABEL): string {
  const headline = oneLine(creative.headline) || "A message from our sponsor";
  return `${headline} (${labelText(label)})`;
}

/**
 * The ad as minimal HTML, for a `<description>` / `<content>` / `content_html`.
 *
 * Every element here survives the strictest sanitiser in common use, and the
 * hierarchy is carried by the elements themselves rather than by attributes, so
 * stripping every `style=` on the way in costs the unit nothing.
 */
export function renderFeedHtml(
  creative: AdCreative,
  clickUrl: string,
  opts: FeedRenderOpts = {},
): string {
  const style = opts.style ?? "text";
  const label = labelText(opts.label);
  const href = esc(clickUrl);
  const link = (inner: string) =>
    `<a href="${href}" rel="${LINK_REL}" target="_blank">${inner}</a>`;
  const headline = esc(oneLine(creative.headline));
  const body = esc(oneLine(creative.body));
  const cta = esc(ctaLabel(creative.ctaText));
  const credit = `<a href="${esc(ATTRIBUTION_URL)}" rel="${LINK_REL}" target="_blank">${esc(ATTRIBUTION)}</a>`;

  if (style === "terminal") {
    // The same ASCII box the MOTD endpoint serves, in the one element every
    // reader renders monospaced and un-reflowed. Escaped after rendering, since
    // the artwork legitimately contains characters XML reserves.
    const art = renderCreativeText(creative, clickUrl, { cols: opts.cols, color: false });
    return [
      `<p><strong>${esc(label)}</strong></p>`,
      `<pre>${esc(art)}</pre>`,
      `<p><small>${credit}</small></p>`,
    ].join("\n");
  }

  // The long form. Real paragraphs of editorial prose, for a placement that
  // sits inside somebody's writing. Falls through to the card when a campaign
  // has no long summary: an "article" carrying a single line is just a worse
  // card, and every campaign generated before this feature has none.
  if (style === "article") {
    const paragraphs = summaryParagraphs(opts.summary?.long);
    if (paragraphs.length > 0) {
      const parts: string[] = [];

      if (creative.imageUrl) {
        parts.push(
          `<p>${link(`<img src="${esc(creative.imageUrl)}" alt="${headline}" width="600" />`)}</p>`,
        );
      }
      parts.push(`<h3>${link(headline)}</h3>`);
      // The prose is the body here, not the one-line creative copy. It is
      // third-person editorial written from the advertiser's own site, which is
      // what lets it sit next to a blog post without reading as an intrusion.
      for (const paragraph of paragraphs) parts.push(`<p>${esc(paragraph)}</p>`);
      parts.push(`<p>${link(`<strong>${cta} &#8594;</strong>`)}</p>`);

      const host = destinationHost(clickUrl, creative);
      const mark = creative.logoUrl
        ? `<img src="${esc(creative.logoUrl)}" alt="" height="20" /> `
        : "";
      // Disclosure matters more here than anywhere else in this file: the whole
      // point of the long form is that it reads like editorial, so the line
      // saying it is paid for is the only thing distinguishing it from the
      // post above it.
      parts.push(
        `<p><small>${mark}${esc(label)}${host ? ` &#183; ${esc(host)}` : ""} &#183; ${credit}</small></p>`,
      );
      return parts.join("\n");
    }
  }

  if (style === "card" || style === "article") {
    // The substantial one. A feed item sits between real blog posts, each of
    // which has a title, a picture and a few paragraphs — so a bare line of
    // text does not read as restrained next to them, it reads as broken, and
    // gets skipped. This carries the artwork the advertiser already has.
    //
    // Every field here is one the advertiser supplied. Nothing is padded out
    // with invented copy: an ad that describes a product in words its owner
    // never wrote is a fabricated claim, however good it looks.
    const parts: string[] = [];

    // Lead with the picture, the way the posts around it do. width is set and
    // height deliberately is not: readers scale to their own column width, and
    // a fixed height would distort every image that is not exactly 2:1.
    if (creative.imageUrl) {
      parts.push(
        `<p>${link(`<img src="${esc(creative.imageUrl)}" alt="${headline}" width="600" />`)}</p>`,
      );
    }

    parts.push(`<h3>${link(headline)}</h3>`);
    // The short summary when the campaign has one: it is a written sentence
    // rather than a 76-character banner line, which is what the item needs when
    // it sits between real posts. The creative body is the fallback.
    const prose = esc(oneLine(opts.summary?.short)) || body;
    if (prose) parts.push(`<p>${prose}</p>`);
    parts.push(`<p>${link(`<strong>${cta} &#8594;</strong>`)}</p>`);

    // The brand line: the logo where there is one, and always the destination
    // host. Naming who is paying is the single most useful thing a disclosure
    // can do — "Sponsored" tells a reader an ad is an ad, and the domain tells
    // them whose it is, which is what they actually decide on.
    const host = destinationHost(clickUrl, creative);
    const mark = creative.logoUrl
      ? `<img src="${esc(creative.logoUrl)}" alt="" height="20" /> `
      : "";
    parts.push(
      `<p><small>${mark}${esc(label)}${host ? ` &#183; ${esc(host)}` : ""} &#183; ${credit}</small></p>`,
    );

    return parts.join("\n");
  }

  // 'text' — one line. The em dash and middle dot are the separators because
  // they survive plain-text degradation, which a border never does.
  const middle = body ? ` &#8212; ${body}` : "";
  return (
    `<p><strong>${esc(label)}</strong> &#183; ` +
    `${link(`<strong>${headline}</strong>`)}${middle} ` +
    `${link(`${cta} &#8594;`)} ` +
    `<small>(${credit})</small></p>`
  );
}

/**
 * The ad as Markdown, for feed builders and newsletters that template in it.
 *
 * Kept to the subset every Markdown implementation agrees on — no tables, no
 * raw HTML, no reference links — because this is very often pasted into
 * somebody's static site generator rather than parsed by ours.
 */
export function renderFeedMarkdown(
  creative: AdCreative,
  clickUrl: string,
  opts: FeedRenderOpts = {},
): string {
  const style = opts.style ?? "text";
  const label = labelText(opts.label);
  const headline = mdEsc(oneLine(creative.headline));
  const body = mdEsc(oneLine(creative.body));
  const cta = mdEsc(ctaLabel(creative.ctaText));
  const url = mdUrl(clickUrl);
  const credit = `*[${mdEsc(ATTRIBUTION)}](${mdUrl(ATTRIBUTION_URL)})*`;

  if (style === "terminal") {
    const art = renderCreativeText(creative, clickUrl, { cols: opts.cols, color: false });
    // A fenced block, because the box is fixed-width art and indenting it four
    // spaces would break the moment a line already starts with whitespace.
    return [`**${label}**`, "", "```", art, "```", "", credit].join("\n");
  }

  // Long form, for a Markdown-templated blog post or newsletter.
  if (style === "article") {
    const paragraphs = summaryParagraphs(opts.summary?.long);
    if (paragraphs.length > 0) {
      const lines: string[] = [];
      if (creative.imageUrl) lines.push(`[![${headline}](${mdUrl(creative.imageUrl)})](${url})`, "");
      lines.push(`### [${headline}](${url})`, "");
      for (const paragraph of paragraphs) lines.push(mdEsc(paragraph), "");
      lines.push(`[**${cta} →**](${url})`, "");
      const host = destinationHost(clickUrl, creative);
      lines.push(`*${label}${host ? ` · ${mdEsc(host)}` : ""} · ${mdEsc(ATTRIBUTION)}*`);
      return lines.join("\n");
    }
  }

  if (style === "card" || style === "article") {
    // Mirrors the HTML card: artwork first, then the headline, the body, the
    // call to action, and a brand line naming who is paying.
    const lines: string[] = [];
    if (creative.imageUrl) lines.push(`[![${headline}](${mdUrl(creative.imageUrl)})](${url})`, "");
    lines.push(`### [${headline}](${url})`, "");
    const prose = mdEsc(oneLine(opts.summary?.short)) || body;
    if (prose) lines.push(prose, "");
    lines.push(`[**${cta} →**](${url})`, "");
    const host = destinationHost(clickUrl, creative);
    lines.push(`*${label}${host ? ` · ${mdEsc(host)}` : ""} · ${mdEsc(ATTRIBUTION)}*`);
    return lines.join("\n");
  }

  const middle = body ? ` — ${body}` : "";
  return `**${label}** · [**${headline}**](${url})${middle} [${cta} →](${url}) ${credit}`;
}

/**
 * The ad as plain text, for a `content_text`, a digest email, or a Gemini or
 * Gopher mirror of the feed.
 */
export function renderFeedText(
  creative: AdCreative,
  clickUrl: string,
  opts: FeedRenderOpts = {},
): string {
  const label = labelText(opts.label);
  if ((opts.style ?? "text") === "terminal") {
    return renderCreativeText(creative, clickUrl, { cols: opts.cols, color: false });
  }
  const headline = oneLine(creative.headline);
  const cta = ctaLabel(creative.ctaText);

  // The long form as plain prose, paragraphs separated by blank lines.
  const paragraphs = (opts.style ?? "text") === "article"
    ? summaryParagraphs(opts.summary?.long)
    : [];
  if (paragraphs.length > 0) {
    return [
      `[${label}] ${headline}`,
      "",
      paragraphs.join("\n\n"),
      "",
      `${cta}: ${clickUrl}`,
      `-- ${ATTRIBUTION} (${ATTRIBUTION_URL})`,
    ].join("\n");
  }

  // Short summary where there is one, else the creative's own line.
  const body = oneLine(opts.summary?.short) || oneLine(creative.body);
  return [`[${label}] ${headline}`, body, `${cta}: ${clickUrl}`, `-- ${ATTRIBUTION} (${ATTRIBUTION_URL})`]
    .filter(Boolean)
    .join("\n");
}

/**
 * The host a reader will end up on, for the brand line.
 *
 * Our click URL is a redirector, so its host is always crawlproof.com and is
 * useless here — the advertiser's own domain is what the reader wants to see.
 * It is not on the creative, so this falls back to the logo's host, which for
 * essentially every campaign is the advertiser's own CDN or site. Returns ""
 * rather than guessing when there is nothing trustworthy to show.
 */
export function destinationHost(clickUrl: string, creative: AdCreative): string {
  for (const candidate of [creative.logoUrl, creative.imageUrl]) {
    if (!candidate) continue;
    try {
      const host = new URL(candidate).hostname.replace(/^www\./, "");
      // Our own storage tells the reader nothing about who is advertising.
      if (/crawlproof\.com$|supabase\.(co|in)$/i.test(host)) continue;
      return host;
    } catch {
      // Not a URL we can read a host out of; try the next one.
    }
  }
  return "";
}

/** Escape the Markdown punctuation that would otherwise reformat ad copy. */
function mdEsc(v: string): string {
  return String(v ?? "").replace(/([\\`*_[\]()<>#+\-!|])/g, "\\$1");
}

/**
 * A URL safe to sit inside `(...)` in a Markdown link.
 *
 * Only spaces and parentheses can terminate the target early, and percent
 * encoding them is understood everywhere — escaping them with a backslash is
 * not.
 *
 * The encoding is spelled out rather than delegated to encodeURIComponent,
 * which does *not* escape parentheses: they are unreserved as far as URI syntax
 * is concerned, and it is only Markdown's link grammar that cares. Using it
 * here made this function a no-op on exactly the input it exists to handle.
 */
const MD_URL_ESCAPES: Record<string, string> = { "(": "%28", ")": "%29", " ": "%20" };

function mdUrl(v: string): string {
  return String(v ?? "").replace(/[()\s]/g, (c) => MD_URL_ESCAPES[c] ?? encodeURIComponent(c));
}

// ----------------------------------------------------------------- envelopes

export type FeedItemInput = {
  creative: AdCreative;
  clickUrl: string;
  /** The slot being filled — namespaces the guid. */
  slotId: string;
  /** The fill's impression id, for `guidMode: 'fill'` and for the debug field. */
  impressionId: string;
  /** Which inventory the fill came from. Surfaced so a consumer can log it. */
  tier?: string;
  /** 0-based place in a multi-ad request. Namespaces the guid — see `adGuid`. */
  position?: number;
  /**
   * The campaign's editorial prose, when it still describes the destination.
   * `card` prefers the short form over the creative's one-line body, and
   * `article` is built from the long form. Absent is ordinary, not an error.
   */
  summary?: { short: string | null; long: string | null } | null;
};

/** Everything the shapes below are rendered from, computed once. */
function assemble(input: FeedItemInput, opts: FeedRenderOpts) {
  // The prose belongs to the campaign and arrives on the input; the body
  // renderers read it off opts, so merge it in once here rather than at each
  // of the three call sites below.
  if (input.summary && !opts.summary) opts = { ...opts, summary: input.summary };
  const { guid, published } = adGuid(opts.guidMode ?? "daily", {
    slotId: input.slotId,
    impressionId: input.impressionId,
    position: input.position,
    now: opts.now,
  });
  return {
    guid,
    published,
    title: feedTitle(input.creative, opts.label),
    label: labelText(opts.label),
    html: renderFeedHtml(input.creative, input.clickUrl, opts),
    markdown: renderFeedMarkdown(input.creative, input.clickUrl, opts),
    text: renderFeedText(input.creative, input.clickUrl, opts),
  };
}

/**
 * An RSS 2.0 `<item>`, ready to splice into somebody else's `<channel>`.
 *
 * Core elements only — see the namespace note at the top of this file. That
 * rules out `<dc:creator>` for the advertiser name and Media RSS for the logo,
 * both of which would be nicer and neither of which is worth invalidating a
 * publisher's document over. `<category>` carries the disclosure in a form a
 * reader can filter on.
 */
export function renderRssItem(input: FeedItemInput, opts: FeedRenderOpts = {}): string {
  const a = assemble(input, opts);
  return [
    "<item>",
    `  <title>${esc(a.title)}</title>`,
    `  <link>${esc(input.clickUrl)}</link>`,
    // isPermaLink="false" because the guid is a tag: URI. Left at the default
    // (true), a reader is entitled to treat it as a fetchable address.
    `  <guid isPermaLink="false">${esc(a.guid)}</guid>`,
    `  <pubDate>${esc(rfc822(a.published))}</pubDate>`,
    `  <category>${esc(a.label)}</category>`,
    `  <description>${cdata(a.html)}</description>`,
    "</item>",
  ].join("\n");
}

/**
 * An Atom 1.0 `<entry>`.
 *
 * Atom is the stricter of the two: `<id>` must be an IRI and `<updated>` is
 * mandatory, which is why the identity above is a tag: URI rather than a bare
 * string. No prefixes are needed — these inherit the default namespace from the
 * publisher's `<feed>` element.
 */
export function renderAtomEntry(input: FeedItemInput, opts: FeedRenderOpts = {}): string {
  const a = assemble(input, opts);
  const iso = a.published.toISOString();
  return [
    "<entry>",
    `  <title>${esc(a.title)}</title>`,
    `  <id>${esc(a.guid)}</id>`,
    `  <updated>${esc(iso)}</updated>`,
    `  <published>${esc(iso)}</published>`,
    `  <link rel="alternate" type="text/html" href="${esc(input.clickUrl)}" />`,
    `  <category term="sponsored" label="${esc(a.label)}" />`,
    `  <rights>${esc(`${a.label} — ${ATTRIBUTION}`)}</rights>`,
    `  <content type="html">${cdata(a.html)}</content>`,
    "</entry>",
  ].join("\n");
}

/**
 * A JSON Feed 1.1 item object.
 *
 * `_crawlproof` is an extension field: the leading underscore is the spec's own
 * way of saying "this is ours", and a reader that does not recognise it is
 * required to ignore it rather than choke. It carries the machine-readable
 * disclosure, which `tags` carries only as a human string.
 */
export function jsonFeedItem(
  input: FeedItemInput,
  opts: FeedRenderOpts = {},
): Record<string, unknown> {
  const a = assemble(input, opts);
  return {
    id: a.guid,
    url: input.clickUrl,
    title: a.title,
    content_html: a.html,
    content_text: a.text,
    date_published: a.published.toISOString(),
    tags: [a.label],
    _crawlproof: {
      sponsored: true,
      label: a.label,
      attribution: ATTRIBUTION,
      impression_id: input.impressionId,
      ...(input.tier ? { tier: input.tier } : {}),
    },
  };
}

/**
 * The raw material, for anyone templating the item themselves.
 *
 * This is the integration shape rather than a convenience: a consumer that
 * already builds RSS, Atom and JSON — rssamplifier.com does — is far better off
 * rendering the ad through its own renderers than splicing our fragment into
 * its document, because then there is exactly one place that decides how a
 * title gets escaped. Every pre-rendered body is included too, so a consumer
 * can take the parts it wants and ignore the rest.
 */
export function feedFields(
  input: FeedItemInput,
  opts: FeedRenderOpts = {},
): Record<string, unknown> {
  const a = assemble(input, opts);
  const c = input.creative;
  return {
    ok: true,
    sponsored: true,
    guid: a.guid,
    title: a.title,
    label: a.label,
    headline: oneLine(c.headline),
    body: oneLine(c.body),
    cta: ctaLabel(c.ctaText),
    url: input.clickUrl,
    publishedAt: a.published.toISOString(),
    attribution: ATTRIBUTION,
    attributionUrl: ATTRIBUTION_URL,
    impressionId: input.impressionId,
    position: input.position ?? 0,
    tier: input.tier ?? null,
    logoUrl: c.logoUrl,
    imageUrl: c.imageUrl,
    colors: { bg: c.bgColor, fg: c.fgColor, accent: c.accentColor },
    // Editorial prose about the advertiser, for a publisher writing the ad into
    // their own content rather than rendering ours. Both are null for campaigns
    // that predate the feature or whose destination has since been edited, so a
    // consumer must treat them as optional and fall back to `body`.
    summaryShort: oneLine(input.summary?.short) || null,
    summaryLong: input.summary?.long || null,
    summaryParagraphs: summaryParagraphs(input.summary?.long),
    html: a.html,
    markdown: a.markdown,
    text: a.text,
  };
}

/**
 * Render a fill in whichever shape was asked for.
 *
 * Returns the body plus the content type to send it with, so the route stays a
 * parameter-parsing exercise and every decision about the document itself lives
 * in this file.
 */
export function renderFeedAd(
  shape: FeedShape,
  input: FeedItemInput,
  opts: FeedRenderOpts = {},
): { body: string; contentType: string } {
  switch (shape) {
    case "rss":
      // application/xml rather than application/rss+xml: this is a *fragment*,
      // not a feed, and labelling it as one makes a reader that follows the
      // link try to subscribe to a document with no channel in it.
      return {
        body: `${renderRssItem(input, opts)}\n`,
        contentType: "application/xml; charset=utf-8",
      };
    case "atom":
      return {
        body: `${renderAtomEntry(input, opts)}\n`,
        contentType: "application/xml; charset=utf-8",
      };
    case "json":
      return {
        body: `${JSON.stringify(jsonFeedItem(input, opts), null, 2)}\n`,
        contentType: "application/json; charset=utf-8",
      };
    case "fields":
      return {
        body: `${JSON.stringify(feedFields(input, opts), null, 2)}\n`,
        contentType: "application/json; charset=utf-8",
      };
    case "html":
      return {
        body: `${renderFeedHtml(input.creative, input.clickUrl, opts)}\n`,
        contentType: "text/html; charset=utf-8",
      };
    case "markdown":
      return {
        body: `${renderFeedMarkdown(input.creative, input.clickUrl, opts)}\n`,
        contentType: "text/markdown; charset=utf-8",
      };
    case "text":
    default:
      return {
        body: `${renderFeedText(input.creative, input.clickUrl, opts)}\n`,
        contentType: "text/plain; charset=utf-8",
      };
  }
}
