// Bluesky rich-text facets.
//
// Bluesky does not parse anything out of post text. A URL posted as plain
// text stays plain text, and a hashtag is just a word starting with '#'.
// Anything that should be clickable has to be described by a facet giving its
// byte range and what it points at. There is no auto-parse flag to set.
//
// The part that bites: those offsets are counted in UTF-8 *bytes*, while
// JavaScript string indices are UTF-16 code units. Any emoji, accented
// character or CJK text before a link shifts the two apart, and the facet
// then highlights the wrong span — usually mid-word, sometimes past the end
// of the string. Every offset here is converted through Buffer.byteLength.

export type BlueskyFacet = {
  index: { byteStart: number; byteEnd: number };
  features: Array<
    | { $type: "app.bsky.richtext.facet#link"; uri: string }
    | { $type: "app.bsky.richtext.facet#tag"; tag: string }
  >;
};

/** Bluesky counts 300 graphemes, and separately caps the record at 3000 bytes. */
const MAX_GRAPHEMES = 300;
const MAX_BYTES = 3000;

const URL_RE = /https?:\/\/[^\s<>"']+/g;

// A '#' that starts a word, followed by tag characters. The lookbehind stops
// it firing inside a URL fragment or an id like `foo#bar`.
const TAG_RE = /(?<![\w/])#([^\s#.,;:!?()[\]{}<>"']+)/g;

/** Trailing characters that are almost always sentence punctuation, not URL. */
const TRAILING_PUNCT = /[.,;:!?)\]}'"]+$/;

function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/**
 * Byte offset of a UTF-16 index, which is what the facet index actually means.
 */
function byteOffsetOf(text: string, charIndex: number): number {
  return byteLen(text.slice(0, charIndex));
}

/**
 * Build the facets for a post.
 *
 * Returns them sorted by start offset and non-overlapping, which is what the
 * API expects; an unsorted or overlapping set is rejected or renders wrong.
 */
export function buildFacets(text: string): BlueskyFacet[] {
  const facets: BlueskyFacet[] = [];
  const taken: Array<[number, number]> = [];

  const overlaps = (start: number, end: number) =>
    taken.some(([s, e]) => start < e && end > s);

  for (const m of text.matchAll(URL_RE)) {
    const raw = m[0];
    // "Read https://example.com." should link the URL, not the full stop.
    // Closing brackets only come off when unbalanced, so a URL that
    // legitimately ends in ')' — Wikipedia does this — survives.
    let url = raw.replace(TRAILING_PUNCT, "");
    if (url.includes("(") && !url.includes(")") && raw.startsWith(url + ")")) {
      url = url + ")";
    }
    if (!url) continue;

    const start = m.index ?? 0;
    const end = start + url.length;
    if (overlaps(start, end)) continue;
    taken.push([start, end]);

    facets.push({
      index: { byteStart: byteOffsetOf(text, start), byteEnd: byteOffsetOf(text, end) },
      features: [{ $type: "app.bsky.richtext.facet#link", uri: url }],
    });
  }

  for (const m of text.matchAll(TAG_RE)) {
    const tag = m[1].replace(TRAILING_PUNCT, "");
    // Bluesky rejects an empty tag, caps them at 64 characters, and a
    // purely numeric one is nearly always "#1" in prose rather than a tag.
    if (!tag || tag.length > 64 || /^\d+$/.test(tag)) continue;

    const start = m.index ?? 0;
    const end = start + 1 + tag.length;
    if (overlaps(start, end)) continue;
    taken.push([start, end]);

    facets.push({
      index: { byteStart: byteOffsetOf(text, start), byteEnd: byteOffsetOf(text, end) },
      features: [{ $type: "app.bsky.richtext.facet#tag", tag }],
    });
  }

  return facets.sort((a, b) => a.index.byteStart - b.index.byteStart);
}

/**
 * Length as Bluesky counts it: graphemes, not UTF-16 code units.
 *
 * `"🚀".length` is 2, and a post of 200 emoji is 400 by that measure but 200
 * by Bluesky's — so a naive length check rejects posts the API would accept.
 */
export function graphemeLength(text: string): number {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].length;
  }
  return [...text].length;
}

/**
 * Trim a post to Bluesky's limits without corrupting it.
 *
 * `text.slice(0, 300)` is wrong twice over: it counts UTF-16 code units, so an
 * emoji spends two of the 300, and it can cut between the halves of a
 * surrogate pair, producing a lone surrogate that is not valid UTF-8. This
 * cuts on grapheme boundaries where the runtime can identify them, then
 * enforces the byte ceiling separately.
 */
export function truncateForBluesky(text: string): string {
  let out = text;

  const segmenter =
    typeof Intl !== "undefined" && "Segmenter" in Intl
      ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
      : null;

  if (segmenter) {
    const graphemes = [...segmenter.segment(out)].map((s) => s.segment);
    if (graphemes.length > MAX_GRAPHEMES) out = graphemes.slice(0, MAX_GRAPHEMES).join("");
  } else {
    // No Segmenter: fall back to code points, which at least never splits a
    // surrogate pair the way slice() does.
    const points = [...out];
    if (points.length > MAX_GRAPHEMES) out = points.slice(0, MAX_GRAPHEMES).join("");
  }

  // Byte ceiling. Drop whole code points so the result stays valid UTF-8.
  while (byteLen(out) > MAX_BYTES) {
    const points = [...out];
    points.pop();
    out = points.join("");
  }

  return out;
}

/** The full post record, facets included. */
export function buildPostRecord(text: string, createdAt: string) {
  const trimmed = truncateForBluesky(text);
  const facets = buildFacets(trimmed);
  return {
    $type: "app.bsky.feed.post" as const,
    text: trimmed,
    createdAt,
    // Omitted entirely when empty: an empty array is legal but noise.
    ...(facets.length ? { facets } : {}),
  };
}
