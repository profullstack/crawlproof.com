// What kind of thing a campaign advertises.
//
// ad_campaigns records no kind, so this is derived from the destination. It
// exists because "generate videos for the ads" does not mean every campaign
// row: a large share of them point at blog posts, and rendering a pre-roll for
// an article nobody asked to promote that way is the expensive mistake.
//
// The shapes below are taken from the live table rather than imagined. In
// particular, most blog campaigns do NOT have a /blog/ path prefix:
//
//   dev.profullstack.com/~anthony/blog/126-post.html   (under a ~user dir)
//   dev.to/chovy/<slug>                                (path is /user/slug)
//
// A naive /^\/blog/ match catches neither, which is why the domain families
// are matched explicitly.

const SOCIAL_DOMAIN =
  /^(twitter\.com|x\.com|.*mastodon.*|bsky\.app|threads\.net|linkedin\.com|facebook\.com|instagram\.com|reddit\.com|youtube\.com|youtu\.be|t\.me|discord\.(gg|com)|tiktok\.com)$/i;

const BLOG_PLATFORM =
  /^(dev\.to|medium\.com|.*\.medium\.com|.*\.hashnode\.dev|.*\.substack\.com|hackernoon\.com|lobste\.rs)$/i;

// Path segments, so /newsletter-tool stays a product while /news/thing does not.
const BLOG_PATH = /(^|\/)(blog|posts?|article|articles|news)(\/|$)|-post\.html$/i;

export type CampaignKind = "product" | "blog" | "social";

/**
 * Classify a campaign by where it points.
 *
 * Affiliate and referral links count as product: they advertise something a
 * person can buy, which is the distinction that matters. An unparseable
 * destination is deliberately not classified as a product — something we cannot
 * show to be one should not get a render.
 */
export function classifyCampaign(destinationUrl: string): CampaignKind {
  let host = "";
  let path = "/";
  try {
    const u = new URL(destinationUrl);
    host = u.hostname.replace(/^www\./, "").toLowerCase();
    path = u.pathname || "/";
  } catch {
    return "blog";
  }
  if (SOCIAL_DOMAIN.test(host)) return "social";
  if (BLOG_PLATFORM.test(host)) return "blog";
  if (BLOG_PATH.test(path)) return "blog";
  return "product";
}
