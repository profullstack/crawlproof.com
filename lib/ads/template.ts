// Server-side ad template tokens.
//
// A text/HTML template marks where ads go with a token, and the server swaps in
// a fill before sending the response. This is the only workable model for
// terminal surfaces (MOTDs, SSH banners, BBS screens) — there's no /ad.js to
// run and no <iframe> to place, so the publisher's own server does the
// substitution:
//
//   {{ads}}                  one terminal ad at the default width
//   {{ads:64}}               terminal ad, 64 columns
//   {{ads:terminal}}         explicit format
//   {{ads:terminal:64}}      explicit format + width
//   {{ads:text_link}}        a different format (HTML surfaces)
//   {{ad}}                   singular alias for any of the above
//
// Unknown formats resolve to the terminal box rather than leaving a raw token
// in someone's login banner. Pure module — no I/O — so the caller decides how
// a token is filled (HTTP fetch, direct serveAd call, cache).

import { AD_FORMAT_IDS, TERMINAL_FORMAT_ID, type AdFormatId } from "./formats";
import { TERMINAL_COLS, clampCols } from "./terminal";

/** Matches {{ads}} / {{ad}} with optional :args, tolerant of inner spaces. */
const TOKEN_RE = /\{\{\s*ads?\s*(?::\s*([^}]*?)\s*)?\}\}/gi;

export type AdToken = {
  /** The exact token text, for a literal replace. */
  raw: string;
  format: AdFormatId;
  /** Only meaningful for the terminal format. */
  cols: number;
};

// Friendly aliases so a publisher doesn't have to remember the db format ids.
const FORMAT_ALIASES: Record<string, AdFormatId> = {
  terminal: TERMINAL_FORMAT_ID,
  ascii: TERMINAL_FORMAT_ID,
  motd: TERMINAL_FORMAT_ID,
  text: "text_link",
  textlink: "text_link",
  link: "text_link",
  rect: "banner_300x250",
  rectangle: "banner_300x250",
  leaderboard: "banner_728x90",
  mobile: "banner_320x50",
};

function resolveFormat(arg: string): AdFormatId | null {
  const key = arg.toLowerCase().replace(/[\s-]+/g, "_");
  if ((AD_FORMAT_IDS as string[]).includes(key)) return key as AdFormatId;
  return FORMAT_ALIASES[key.replace(/_/g, "")] ?? FORMAT_ALIASES[key] ?? null;
}

function parseArgs(args: string | undefined): { format: AdFormatId; cols: number } {
  let format: AdFormatId = TERMINAL_FORMAT_ID;
  let cols = TERMINAL_COLS;
  for (const part of (args ?? "").split(":")) {
    const arg = part.trim();
    if (!arg) continue;
    // A bare number is a column count; anything else names a format.
    if (/^\d+$/.test(arg)) {
      cols = clampCols(arg);
      continue;
    }
    format = resolveFormat(arg) ?? format;
  }
  return { format, cols };
}

/** Every ad token in a template, in document order (duplicates included). */
export function parseAdTokens(template: string): AdToken[] {
  const out: AdToken[] = [];
  for (const m of String(template ?? "").matchAll(TOKEN_RE)) {
    out.push({ raw: m[0], ...parseArgs(m[1]) });
  }
  return out;
}

export function hasAdToken(template: string): boolean {
  // matchAll avoids the lastIndex footgun of reusing a /g regex with .test().
  return parseAdTokens(template).length > 0;
}

/**
 * Replace every ad token with the fill returned by `fill(token)`.
 *
 * Tokens are filled concurrently and identical tokens are only filled once, so
 * a template with three `{{ads}}` renders the same ad three times rather than
 * metering three impressions. A fill that throws or returns null removes the
 * token — a template must never leak `{{ads}}` into the output.
 */
export async function renderAdTemplate(
  template: string,
  fill: (token: AdToken) => Promise<string | null>,
): Promise<string> {
  const text = String(template ?? "");
  const tokens = parseAdTokens(text);
  if (tokens.length === 0) return text;

  const byRaw = new Map<string, AdToken>();
  for (const t of tokens) if (!byRaw.has(t.raw)) byRaw.set(t.raw, t);

  const filled = new Map<string, string>();
  await Promise.all(
    [...byRaw.values()].map(async (token) => {
      const value = await fill(token).catch(() => null);
      filled.set(token.raw, value ?? "");
    }),
  );

  return text.replace(TOKEN_RE, (raw) => filled.get(raw) ?? "");
}
