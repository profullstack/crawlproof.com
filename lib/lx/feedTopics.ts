// Guest-post subjects taken from what the small web is actually writing about.
//
// The crossed-seed topics that `guestPostMatcher` produces are combinations of
// two sites' own keywords — reliable, and finite. Once a partner has been
// written for a few times the crossings run out and the slot goes back to the
// author's own blog. This is the other source: a real, recently published post
// from an RSS Amplifier topic feed, used as the subject for a full article.
//
// The article is still entirely ours — the generator writes it from scratch on
// the subject. Nothing is copied. What the feed contributes is a subject that
// somebody in the niche genuinely cared about this week, rather than one
// assembled from two keyword lists.
//
// Three things this is careful about, and the first is the one that would be
// most embarrassing.

/** Where the directory lives. */
const RSSAMPLIFIER = "https://rssamplifier.com";

/**
 * How long to wait for a topic feed.
 *
 * This runs inside the publishing cron, which is walking every active site. A
 * slow directory must cost one site its guest post, not the whole sweep, so the
 * budget is small and every failure path returns null.
 */
const TIMEOUT_MS = 3000;

/** Feeds tried before giving up on finding a usable subject. */
const MAX_FEEDS = 3;

/** A title shorter than this is not a subject — it is a label. */
const MIN_TITLE_LEN = 24;

/** And one longer than this is a paragraph that will not survive a prompt. */
const MAX_TITLE_LEN = 160;

/**
 * A keyword as it appears in a topic URL.
 *
 * Matches the directory's own slugging — lowercase, non-alphanumerics to
 * hyphens, collapsed. A keyword that slugs to nothing is skipped rather than
 * requested, since `/topics/.rss` is not a feed.
 */
export function topicSlug(keyword: string): string {
  return (keyword ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Titles of real posts in a topic feed.
 *
 * Parsed with a regex rather than an XML library on purpose: this is one known
 * document shape from one known publisher, the only field wanted is the title,
 * and a parse failure here must degrade to "no subject today" rather than
 * throw inside a cron. Dragging an XML dependency into the worker to read one
 * element would be the worse trade.
 *
 * @param xml an RSS document
 * @returns post titles, channel title and sponsored items removed
 */
export function itemTitles(xml: string): string[] {
  return itemEntries(xml).map((e) => e.title);
}

/** A usable post from a topic feed. */
export type FeedEntry = { title: string; link: string | null };

/**
 * Posts in a topic feed, with their links.
 *
 * The link is what a *citation* needs; `itemTitles` only ever needed the
 * subject, and is now a projection of this. Keeping one parser means the
 * sponsored-item exclusion below cannot be enforced on one path and forgotten
 * on the other — and the path that carries links out to a published page is
 * precisely the one where forgetting it would be worst.
 *
 * @param xml an RSS document
 * @returns entries, channel-level and sponsored items removed
 */
export function itemEntries(xml: string): FeedEntry[] {
  const out: FeedEntry[] = [];

  // Item blocks only — this is what keeps the channel's own <title> (the name
  // of the topic) out of the candidate list.
  const items = xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? [];

  for (const item of items) {
    // **Sponsored items are ours.** The directory's feeds now carry CrawlProof
    // ad fills as syndication items, so without this the cron could pick one of
    // our own advertisements and commission a guest post about it — an ad,
    // laundered into editorial, published on a partner's blog under our name.
    // Both the category and the title suffix are checked because either alone
    // is a single point of failure for something that must never happen.
    if (/<category>\s*Sponsored\s*<\/category>/i.test(item)) continue;

    const raw = item.match(/<title>([\s\S]*?)<\/title>/i)?.[1];
    if (!raw) continue;

    const title = decodeXml(raw).trim();
    if (/\(sponsored\)\s*$/i.test(title)) continue;

    if (title.length < MIN_TITLE_LEN || title.length > MAX_TITLE_LEN) continue;

    const href = decodeXml(item.match(/<link>([\s\S]*?)<\/link>/i)?.[1] ?? "").trim();
    // Only absolute http(s) links survive. A feed carrying a relative link, a
    // javascript: URL or a bare guid must not be able to put either into an
    // anchor on a customer's published page.
    const link = /^https?:\/\/\S+$/i.test(href) ? href : null;

    out.push({ title, link });
  }

  return out;
}

/**
 * Real posts from the directory on the subjects given, with links.
 *
 * Unlike `subjectFromTopicFeeds`, which wants one subject to write about, this
 * wants several posts to cite — so it reads across every requested topic
 * rather than stopping at the first that answers, and returns only entries
 * that carry a usable link.
 *
 * @param keywords subject words, tried in random order
 * @param limit most entries to return
 * @param fetchImpl injected by the tests
 */
export async function postsFromTopicFeeds(
  keywords: string[],
  limit = 3,
  fetchImpl: typeof fetch = fetch,
): Promise<Array<{ title: string; link: string; topic: string }>> {
  const slugs = shuffle(
    Array.from(new Set((keywords ?? []).map(topicSlug).filter(Boolean))),
  ).slice(0, MAX_FEEDS);

  const out: Array<{ title: string; link: string; topic: string }> = [];
  const seen = new Set<string>();

  for (const slug of slugs) {
    if (out.length >= limit) break;
    let xml: string;
    try {
      const res = await fetchImpl(
        `${RSSAMPLIFIER}/topics/${encodeURIComponent(slug)}.rss`,
        {
          signal: AbortSignal.timeout(TIMEOUT_MS),
          headers: { accept: "application/rss+xml, application/xml;q=0.9" },
        },
      );
      if (!res.ok) continue;
      xml = await res.text();
    } catch {
      continue;
    }

    // One entry per topic before taking a second from any of them, so a block
    // of three citations shows three subjects rather than three posts from
    // whichever feed happened to be longest.
    const entries = shuffle(itemEntries(xml).filter((e) => e.link));
    for (const entry of entries) {
      if (!entry.link || seen.has(entry.link)) continue;
      seen.add(entry.link);
      out.push({ title: entry.title, link: entry.link, topic: slug.replace(/-/g, " ") });
      break;
    }
  }

  return out.slice(0, limit);
}

/**
 * Undo the escaping a feed document applies, and nothing else.
 *
 * The five predefined entities plus numeric references, because titles arrive
 * carrying `&#8594;` and `&apos;` from fifty thousand different publishers and
 * a subject line reading "Don&apos;t" would be written into the article.
 */
function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Pick a subject at random from what the directory is carrying.
 *
 * Random rather than ranked, deliberately. Ranking these would mean deciding
 * that one publisher's headline is a better subject than another's on evidence
 * we do not have — and the failure it would cause is worse than the one it
 * would prevent: a stable ranking over a slow-moving feed writes about the same
 * thing repeatedly, which is exactly what this source exists to avoid.
 *
 * @param keywords subject words to look for, tried in random order
 * @param fetchImpl injected by the tests
 * @returns a subject, or null to let the caller fall back
 */
export async function subjectFromTopicFeeds(
  keywords: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<{ subject: string; topic: string } | null> {
  const slugs = shuffle(
    Array.from(new Set((keywords ?? []).map(topicSlug).filter(Boolean))),
  ).slice(0, MAX_FEEDS);

  for (const slug of slugs) {
    const titles = await titlesFor(slug, fetchImpl);
    if (titles.length === 0) continue;

    const subject = titles[Math.floor(Math.random() * titles.length)];
    return { subject, topic: slug.replace(/-/g, " ") };
  }

  return null;
}

/**
 * @param slug
 * @param fetchImpl
 * @returns usable titles, or [] for any failure at all
 */
async function titlesFor(slug: string, fetchImpl: typeof fetch): Promise<string[]> {
  try {
    const res = await fetchImpl(`${RSSAMPLIFIER}/topics/${encodeURIComponent(slug)}.rss`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: "application/rss+xml, application/xml;q=0.9" },
    });
    if (!res.ok) return [];
    return itemTitles(await res.text());
  } catch {
    // A missing topic, a slow directory, a malformed document — all the same
    // answer. The caller has an ordinary post to publish instead.
    return [];
  }
}

/**
 * @template T
 * @param xs
 * @returns a shuffled copy
 */
function shuffle<T>(xs: T[]): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
