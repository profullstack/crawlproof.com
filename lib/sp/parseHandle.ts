// Turn whatever someone pastes into the account-name field into the bare
// handle or id the posting code actually needs.
//
// People paste profile URLs — https://x.com/profullstackinc,
// facebook.com/profile.php?id=61556287853382, linkedin.com/in/someone/ —
// and until now we stored that verbatim as both `handle` and
// `external_id`. That breaks posting (createFacebookPagePost gets a URL
// where it wants a page id) and it silently creates a *second* account,
// because the upsert conflict key is (user_id, platform, external_id).
//
// Everything here is pure string work: no network, no platform lookups.
// A bare handle passes through untouched, so pasting an id still works.

export type ParsablePlatform =
  | "reddit"
  | "facebook_page"
  | "threads"
  | "instagram"
  | "x"
  | "linkedin"
  | "mastodon"
  | "bluesky";

export type ParsedHandle = {
  /** The bare handle/id to store. */
  handle: string;
  /** Host the URL pointed at, when the input was a URL — Mastodon needs it. */
  host?: string;
};

// Hosts we recognise per platform. A URL on an unexpected host is left
// alone rather than mangled: better to store what they typed than to
// guess wrong. Mastodon is the exception — any host is a valid instance.
const PLATFORM_HOSTS: Record<ParsablePlatform, string[]> = {
  reddit: ["reddit.com", "redd.it"],
  facebook_page: ["facebook.com", "fb.com", "fb.me"],
  threads: ["threads.net", "threads.com"],
  instagram: ["instagram.com", "instagr.am"],
  x: ["x.com", "twitter.com"],
  linkedin: ["linkedin.com", "lnkd.in"],
  mastodon: [],
  bluesky: ["bsky.app", "bsky.social", "staging.bsky.app"],
};

// Path segments that are never part of a handle — a pasted URL often
// carries one on the end (/about, /posts, /status/123…).
const TRAILING_NOISE = new Set([
  "about",
  "posts",
  "post",
  "status",
  "statuses",
  "photos",
  "videos",
  "reels",
  "with_replies",
  "media",
  "likes",
  "following",
  "followers",
  "recent-activity",
  "details",
  "comments",
  "submitted",
]);

/** Strip www./m./web./mobile. so host matching is boring. */
function baseHost(host: string): string {
  return host.toLowerCase().replace(/^(?:www|m|web|mobile|l|free)\./, "");
}

function hostMatches(host: string, platform: ParsablePlatform): boolean {
  const h = baseHost(host);
  return PLATFORM_HOSTS[platform].some(
    (known) => h === known || h.endsWith(`.${known}`),
  );
}

/**
 * Parse the input as a URL. Accepts scheme-less input
 * ("facebook.com/x", "x.com/y") as long as it looks like a host with a
 * path, so people don't have to paste the https:// too.
 */
function asUrl(raw: string): URL | null {
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : // Only treat it as scheme-less if it starts with something
      // dot-separated that looks like a hostname. "yourusername" must
      // not become a URL.
      /^[a-z0-9-]+(?:\.[a-z0-9-]+)+\//i.test(trimmed)
      ? `https://${trimmed}`
      : null;
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** Path segments, empty ones dropped and percent-decoding undone. */
function segments(url: URL): string[] {
  return url.pathname
    .split("/")
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    })
    .filter(Boolean);
}

/** Drop trailing /about, /status/12345 and friends. */
function trimNoise(parts: string[]): string[] {
  // .../status/1234567 — drop the noise word and everything after it.
  const noiseAt = parts.findIndex((p, i) => i > 0 && TRAILING_NOISE.has(p.toLowerCase()));
  return noiseAt > 0 ? parts.slice(0, noiseAt) : parts;
}

const NUMERIC = /^\d{5,}$/;

function fromFacebook(url: URL): string | null {
  // facebook.com/profile.php?id=61556287853382
  const idParam = url.searchParams.get("id");
  if (idParam && /^\d+$/.test(idParam)) return idParam;

  const parts = trimNoise(segments(url));
  if (parts.length === 0) return null;

  const head = parts[0].toLowerCase();

  // facebook.com/pages/Some-Page-Name/123456789
  // facebook.com/pages/category/Software/Some-Page/123456789
  // facebook.com/people/Some-Name/61556287853382
  if (head === "pages" || head === "people" || head === "pg") {
    const numeric = [...parts].reverse().find((p) => NUMERIC.test(p));
    if (numeric) return numeric;
    // No id in the path — the last named segment is the best we have.
    const named = parts.slice(1).filter((p) => p.toLowerCase() !== "category");
    return named.length ? named[named.length - 1] : null;
  }

  // facebook.com/groups/123456789 — a group is still addressable by id.
  // profile.php with no ?id= is a dead end; fall through to null.
  if (head === "groups" || head === "profile.php") {
    return parts[1] ?? null;
  }

  // facebook.com/MyPage
  return parts[0];
}

function fromLinkedin(url: URL): string | null {
  const parts = trimNoise(segments(url));
  if (parts.length === 0) return null;
  const head = parts[0].toLowerCase();
  // /in/anthonyettinger, /company/profullstack, /school/x
  if (head === "in" || head === "company" || head === "school" || head === "pub") {
    return parts[1] ?? null;
  }
  return parts[0];
}

function fromReddit(url: URL): string | null {
  const parts = trimNoise(segments(url));
  if (parts.length === 0) return null;
  const head = parts[0].toLowerCase();
  // /user/name, /u/name, /r/subreddit
  if (head === "user" || head === "u" || head === "r") return parts[1] ?? null;
  return parts[0];
}

function fromBluesky(url: URL): string | null {
  const parts = trimNoise(segments(url));
  if (parts.length === 0) return null;
  // bsky.app/profile/chovyfu.bsky.social
  if (parts[0].toLowerCase() === "profile") return parts[1] ?? null;
  return parts[0];
}

/** Generic /@handle or /handle, used by threads, instagram, x, mastodon. */
function fromFirstSegment(url: URL): string | null {
  const parts = trimNoise(segments(url));
  if (parts.length === 0) return null;
  const head = parts[0].toLowerCase();
  // x.com/i/... and instagram.com/p/... are not profiles.
  if (head === "i" || head === "p" || head === "reel" || head === "share") {
    return parts[1] ?? null;
  }
  return parts[0];
}

/**
 * Normalise a pasted account name. Never throws; if the input isn't
 * something we recognise, it comes back trimmed and de-@'d so the old
 * behaviour is preserved.
 */
export function parseAccountHandle(
  raw: string,
  platform: ParsablePlatform,
): ParsedHandle {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { handle: "" };

  const url = asUrl(trimmed);
  if (!url) return { handle: trimmed.replace(/^@+/, "") };

  const host = baseHost(url.hostname);

  // Mastodon is federated: any host can be an instance, and the host IS
  // the instance URL we need alongside the username.
  if (platform === "mastodon") {
    const handle = fromFirstSegment(url);
    return handle
      ? { handle: handle.replace(/^@+/, ""), host }
      : { handle: "", host };
  }

  // A URL pointing somewhere else entirely — don't pretend to parse it.
  if (!hostMatches(url.hostname, platform)) {
    return { handle: trimmed.replace(/^@+/, "") };
  }

  let parsed: string | null;
  switch (platform) {
    case "facebook_page":
      parsed = fromFacebook(url);
      break;
    case "linkedin":
      parsed = fromLinkedin(url);
      break;
    case "reddit":
      parsed = fromReddit(url);
      break;
    case "bluesky":
      parsed = fromBluesky(url);
      break;
    default:
      parsed = fromFirstSegment(url);
  }

  // A bare profile root ("https://x.com/") has nothing to take — keep
  // the raw input so the caller's "required" check still complains.
  if (!parsed) return { handle: trimmed.replace(/^@+/, ""), host };
  return { handle: parsed.replace(/^@+/, ""), host };
}
