// How a voice should say what a banner shows.
//
// The voiceover reads the same approved copy the frame does, but a speech
// engine guesses at anything that is not an ordinary word, and our names are
// rarely ordinary words: "logicsrc.com" came out of a station break as
// something like "pioureee dot com". So the narration is rewritten for the ear
// before it is sent, and only for the ear: nothing a listener could read changes.
//
// Three passes, most specific first:
//   1. names we know, said the way we say them (LogicSRC -> "Logic Source");
//   2. initialisms spelled out letter by letter (MCP -> "M C P");
//   3. domains read as a person reads them aloud: each label, then "dot"
//      and the ending ("logicsrc.com" -> "logic source dot com").

/**
 * Our names, as we say them. Keys are lower-case; a match is case-insensitive
 * and whole-word, so "LogicSRC" and "logicsrc" both hit and "logicsrcs" does not.
 */
export const LEXICON: Record<string, string> = {
  logicsrc: "Logic Source",
  pwamart: "P W A mart",
  nixamp: "nix amp",
  readm3: "read me",
  p0dcasters: "podcasters",
  d3vices: "devices",
  b1dz: "bids",
  c0upons: "coupons",
  bl0ggers: "bloggers",
  d0rz: "doors",
  c0mpute: "compute",
  sh1pt: "ship it",
  w3bs: "webs",
  hqtui: "H Q T U I",
  hqterm: "H Q term",
  ugig: "you gig",
  coinpay: "coin pay",
  coinpayportal: "coin pay portal",
  crawlproof: "crawl proof",
  mynaposter: "myna poster",
  moshcode: "mosh code",
  moshcoding: "mosh coding",
  nichedb: "niche D B",
  bufferoverride: "buffer override",
  profullstack: "pro full stack",
  bittorrented: "bit torrented",
  rssamplifier: "R S S amplifier",
  threatcrush: "threat crush",
  tipoffwatch: "tip off watch",
  genrewatch: "genre watch",
  pairux: "pair U X",
  openmcp: "Open M C P",
  qrypt: "crypt",
  brisk: "brisk",
};

/** Letters a voice should name one at a time rather than try to say as a word. */
const INITIALISMS = new Set([
  "ai", "api", "cli", "db", "mcp", "pwa", "tui", "ui", "ux", "seo", "rss", "ios", "pdf", "sdk", "url", "vpn", "gpu", "cpu", "sql", "css", "html", "json", "npm", "hq", "kyc", "nft", "iptv", "tv", "fm", "llm",
]);

/** Endings read as letters ("dot I O"); everything else is read as a word ("dot com"). */
const SPELLED_ENDINGS = new Set(["io", "ai", "sh", "tv", "fm", "co", "me", "gg", "ly", "to", "cc", "dj", "us", "uk", "ca", "de"]);

/** Word pieces a voice mangles, said the way a developer says them. */
const PIECES: Record<string, string> = { src: "source", lib: "lib", dev: "dev", app: "app", hub: "hub", bot: "bot" };

/** Digits standing in for letters inside a name, as people read them. */
const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t" };

function spellLetters(word: string): string {
  return word.toUpperCase().split("").join(" ");
}

/** One label of a domain ("logicsrc", "p0dcasters", "my-app"), for the ear. */
export function spokenLabel(label: string): string {
  const lower = label.toLowerCase();
  if (LEXICON[lower]) return LEXICON[lower].toLowerCase();
  // A long machine-made label (an onion key, a hash) is not a word anyone says.
  if (lower.length > 20) return lower;
  return lower
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => {
      if (LEXICON[part]) return LEXICON[part].toLowerCase();
      if (INITIALISMS.has(part)) return spellLetters(part);
      // A digit between letters is a letter in disguise; a run of digits is a number.
      const unleet = /[a-z]/.test(part) ? part.replace(/(?<=[a-z])[013457](?=[a-z]|$)|(?<=^)[013457](?=[a-z])/g, (d) => LEET[d] ?? d) : part;
      // "logicsrc" -> "logic source": a known piece at the end of a word.
      for (const [piece, said] of Object.entries(PIECES)) {
        if (unleet.length > piece.length + 2 && unleet.endsWith(piece)) return `${unleet.slice(0, -piece.length)} ${said}`;
      }
      return unleet;
    })
    .join(" ");
}

/** A domain read aloud: "logicsrc.com" -> "logic source dot com". */
export function spokenDomain(domain: string): string {
  const bare = domain.trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/.*$/, "").toLowerCase();
  if (!bare) return "";
  // An onion address is copied, never spoken; leave it exactly as printed.
  if (bare.endsWith(".onion")) return bare;
  const labels = bare.split(".").filter(Boolean);
  if (labels.length === 1) return spokenLabel(labels[0]);
  const ending = labels.pop()!;
  const said = labels.map(spokenLabel);
  const tail = SPELLED_ENDINGS.has(ending) ? spellLetters(ending) : ending;
  return `${said.join(" dot ")} dot ${tail}`;
}

const DOMAIN_IN_TEXT = /\b(?:https?:\/\/)?(?:www\.)?((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]{1,23})\b(?:\/[^\s]*[^\s.,!?;:])?/gi;

/**
 * A whole line rewritten for the ear: domains first (so their labels are not
 * rewritten twice), then known names, then initialisms. Sentence punctuation
 * is left alone, which is what gives the read its pauses.
 */
export function spokenText(text: string): string {
  const domains: string[] = [];
  let out = text.replace(DOMAIN_IN_TEXT, (_match, host: string) => {
    domains.push(spokenDomain(host));
    return `\u0000${domains.length - 1}\u0000`;
  });
  out = out.replace(/\b[A-Za-z0-9][A-Za-z0-9-]*\b/g, (word) => {
    const lower = word.toLowerCase();
    if (LEXICON[lower]) return LEXICON[lower];
    if (INITIALISMS.has(lower) && word === word.toUpperCase() && word.length > 1) return spellLetters(lower);
    return word;
  });
  return out.replace(/\u0000(\d+)\u0000/g, (_m, index: string) => domains[Number(index)] ?? "");
}
