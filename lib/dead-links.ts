// Links to other sites that are confirmed dead (404 on re-check 2026-10-17, from
// the ThreatCrush Link Watch report). Post bodies arrive by webhook or as user
// content, so rather than hand-edit rows the dead anchors are unwrapped at
// render time: the link goes, the text stays.

const DEAD_URLS = new Set<string>([
  "https://analytics.ahrefs.com",
  "https://www.googletagmanager.com",
  "https://bxiie.artsfol.io/artwork/in-paint-bxiie-br-34",
  "https://c0upons.com/blog/doordash-promo-codes-for-existing-users-2026-workflow",
  "https://c0upons.com/blog/encrypted-messaging-coupon-codes-private-deal-sharing",
  "https://c0upons.com/blog/shutterfly-promo-codes-2026-checkout-workflow",
  "https://c0upons.com/blog/walgreens-coupon-code-workflow",
  "https://crates.io/crates/graphforge-rel",
  "https://crates.io/crates/piu_node_resolver",
  "https://crates.io/crates/rightkit-credentials",
  "https://crates.io/crates/willbooster-tree-sitter-rust",
  "https://crates.io/crates/wsi-dicom-annotations",
  "https://devdrafts.netlify.app",
  "https://feedbackminer.co/cookies",
  "https://feedbackminer.co/privacy",
  "https://feedbackminer.co/sub-processors",
  "https://feedbackminer.co/terms",
  "https://seniorcontact.app/en/about-us",
]);

/** Placeholder hosts (RFC 2606): never a real page, so never worth a link. */
const PLACEHOLDER_HOST = /^(?:www\.)?example\.(?:com|org|net)$/i;

function normalize(href: string): string {
  return href.replace(/#.*$/, "").replace(/\/+$/, "").toLowerCase();
}

export function isDeadExternalUrl(href: string): boolean {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (PLACEHOLDER_HOST.test(url.hostname)) return true;
  if (url.pathname.startsWith("/cdn-cgi/l/email-protection")) return true;
  return DEAD_URLS.has(normalize(href));
}

const ANCHOR = /<a\s[^>]*?href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;

/** Unwrap every anchor that points at a known-dead URL, keeping its text. */
export function stripDeadLinks(html: string): string {
  return html.replace(ANCHOR, (whole, href: string, inner: string) =>
    isDeadExternalUrl(href.replace(/&amp;/g, "&")) ? inner : whole,
  );
}
