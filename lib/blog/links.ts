// Autoblog posts arrive by webhook and link to other posts by slug, sometimes
// to slugs that were never published (or were retired). Rather than hand-edit
// rows, every /blog/<slug> link is repaired at render time, and a request for
// a missing slug redirects to the post it meant. Same pattern as threatcrush
// PR #333.

/**
 * Slugs that once existed (the hand-written seed posts removed in e2c512d)
 * and that older autoblog posts still link to. Each maps to the page that now
 * covers its subject.
 */
export const RETIRED_SLUGS: Record<string, string> = {
  "what-is-aeo": "/docs/aeo-score",
  "llms-txt-and-skill-md": "/docs/aeo-score",
};

/** Levenshtein distance, stopping early once it exceeds `max`. */
export function editDistance(a: string, b: string, max = Infinity): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * The real slug a mistyped one meant: the closest by edit distance within a
 * quarter of its length (at least 3), or null.
 */
export function closestSlug(slug: string, slugs: Set<string>): string | null {
  if (slugs.has(slug)) return slug;
  const max = Math.max(3, Math.floor(slug.length / 4));
  let best: string | null = null;
  let bestD = max + 1;
  for (const s of slugs) {
    const d = editDistance(slug, s, bestD - 1);
    if (d < bestD) {
      best = s;
      bestD = d;
    }
  }
  return best;
}

/**
 * Where a missing slug should go: a retired slug's replacement, else the
 * closest real post, else null (404).
 */
export function resolveMissingSlug(slug: string, slugs: Set<string>): string | null {
  if (RETIRED_SLUGS[slug]) return RETIRED_SLUGS[slug];
  const meant = closestSlug(slug, slugs);
  return meant && meant !== slug ? `/blog/${meant}` : null;
}

const BLOG_HREF = /href="((?:https?:\/\/(?:www\.)?crawlproof\.com)?)\/blog\/([a-z0-9-]+)\/?((?:[?#][^"]*)?)"/g;

/**
 * Point every /blog/<slug> link in a post at a page that exists: a retired
 * slug's replacement, the slug it meant when one is close, else the blog
 * index. Leaves links to real posts and other sites alone.
 */
export function fixBlogLinks(html: string, slugs: Set<string>): string {
  if (slugs.size === 0) return html;
  return html.replace(BLOG_HREF, (whole, origin: string, slug: string, rest: string) => {
    if (slugs.has(slug)) return whole;
    const target = resolveMissingSlug(slug, slugs);
    if (target) return `href="${origin}${target}${target.startsWith("/blog/") ? rest : ""}"`;
    return `href="${origin}/blog"`;
  });
}
