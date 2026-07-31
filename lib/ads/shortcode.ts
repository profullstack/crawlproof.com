import crypto from "node:crypto";

// Short, URL-safe impression codes, so a paid terminal ad's click URL fits
// inside the ASCII box instead of dangling below it.
//
// The length is not arbitrary — it is what the narrowest supported box can
// afford:
//
//   cols = 44                       the minimum width /api/ads/motd accepts
//   inner = cols - 4 = 40           usable columns between "| " and " |"
//   "https://crawlproof.com/a/"     25 characters of fixed prefix
//   ------------------------------------------------------------------
//   40 - 25 = 15                    columns left for the code
//
// 12 leaves three columns of headroom for a longer origin (a staging host, a
// trailing slash in siteUrl) while still being 71 bits of entropy:
//
//   62^12 ~= 3.2e21 ~= 2^71
//
// For comparison the old form printed the raw impression UUID, 36 characters,
// which needed 61 columns and so never fit a 44-col box.
//
// Entropy matters because the code is the only thing standing between a
// stranger and a click charge on someone else's campaign: /a/<code> meters a
// click against the campaign named by the impression row. Guessing is the
// attack, so the space has to be far too large to sweep. It is deliberately
// well above the ~42 bits a 7-character code would have given.
export const SHORT_CODE_LENGTH = 12;

// Base62. No look-alike stripping: these are copy-pasted or clicked, not read
// aloud, and dropping characters would cost entropy we are already budgeting
// tightly.
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export const SHORT_CODE_RE = new RegExp(`^[0-9A-Za-z]{${SHORT_CODE_LENGTH}}$`);

/** True when `v` looks like an impression short code (not a UUID). */
export function isShortCode(v: string | null | undefined): boolean {
  return typeof v === "string" && SHORT_CODE_RE.test(v);
}

// 256 is not a multiple of 62, so a plain `byte % 62` would make the first four
// symbols marginally more likely. Rejection sampling keeps the distribution
// flat, which is cheap here and means the 71-bit figure above is honest.
const LIMIT = 256 - (256 % ALPHABET.length); // 248

/**
 * A cryptographically random base62 code.
 *
 * Uniqueness is enforced by a unique index on the column, not by this function
 * — at 71 bits a collision is not a practical concern, but the index makes it
 * an error rather than a silently mis-attributed click.
 */
export function generateShortCode(length = SHORT_CODE_LENGTH): string {
  let out = "";
  while (out.length < length) {
    // Over-fetch: on average ~3% of bytes are rejected, so one round is
    // almost always enough.
    const bytes = crypto.randomBytes(length - out.length + 8);
    for (const b of bytes) {
      if (b >= LIMIT) continue;
      out += ALPHABET[b % ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return out;
}
