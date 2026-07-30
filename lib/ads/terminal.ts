// ASCII "terminal" ad renderer - the text twin of renderCreativeHtml.
//
// Consumers are TTYs, not browsers: SSH login banners, shell MOTDs, BBS
// screens, CLI tools. So the output is a fixed-width, pure-ASCII box that
// survives `curl | cat` anywhere, with ANSI colour as an explicit opt-in.
//
// Pure and client-safe (no server-only imports) so the editor preview can
// render exactly what the endpoint serves - same rule as ./formats.

import type { AdCreative } from "./formats";

/** Default box width in columns - fits an 80-col terminal with margin, and
 * leaves room for a click URL carrying a surface tag on one line. */
export const TERMINAL_COLS = 76;
const MIN_COLS = 44;
const MAX_COLS = 120;

/** Disclosure label burned into the top border. */
const SPONSORED_LABEL = "SPONSORED";
/** Attribution burned into the bottom border - the terminal "Advertisement" caption. */
const ATTRIBUTION = "ads by crawlproof.com";

export type TerminalRenderOpts = {
  /** Box width in columns (clamped to 44...120). */
  cols?: number;
  /** Emit ANSI truecolour escapes. Off by default: plain text is the safe wire format. */
  color?: boolean;
  /** Override the top-border label (the house ad uses its own). */
  label?: string;
};

export function clampCols(v: unknown): number {
  const n = typeof v === "string" ? parseInt(v, 10) : typeof v === "number" ? v : NaN;
  if (!Number.isFinite(n)) return TERMINAL_COLS;
  return Math.min(MAX_COLS, Math.max(MIN_COLS, Math.round(n)));
}

// Common non-ASCII punctuation that shows up in ad copy, folded to the ASCII
// equivalent so we degrade to something readable rather than dropping chars.
const FOLD: Array<[RegExp, string]> = [
  [/[‘’‚′]/g, "'"],
  [/[“”„″]/g, '"'],
  [/[–—―]/g, "-"],
  [/…/g, "..."],
  [/[→➡➜]/g, "->"],
  [/[•·]/g, "*"],
  [/[\u00a0\u2007\u2009\u202f]/g, " "],
  [/™/g, "(tm)"],
  [/®/g, "(r)"],
  [/€/g, "EUR"],
  [/£/g, "GBP"],
];

/**
 * Make advertiser copy safe to print into a TTY.
 *
 * Ad copy is untrusted, third-party text and we write it straight to someone's
 * terminal, so every escape/control character is removed - an ESC sequence in a
 * headline could otherwise repaint the screen, ring the bell, or spoof the rest
 * of the MOTD. Stripping to printable ASCII also keeps the box aligned: the
 * layout maths below assumes exactly one column per character, which is false
 * for CJK and emoji.
 */
export function sanitizeTerminalText(input: string | null | undefined): string {
  let s = String(input ?? "");
  for (const [re, to] of FOLD) s = s.replace(re, to);
  // Decompose accents and drop the combining marks, so "Café" degrades to
  // "Cafe" rather than "Caf" once the non-ASCII pass runs.
  s = s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  return s
    // Control chars (incl. ESC 0x1b, BEL, CR/LF) and the C1 range -> space.
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    // Anything else outside printable ASCII -> dropped.
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Greedy word wrap to `width` columns; overlong words are hard-split. */
export function wrapText(text: string, width: number): string[] {
  const words = text.split(" ").filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (word.length > width) {
      if (line) {
        lines.push(line);
        line = "";
      }
      for (let i = 0; i < word.length; i += width) lines.push(word.slice(i, i + width));
      continue;
    }
    if (!line) line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// --- Client classification -------------------------------------------------

// Crawlers we still want to keep off paid inventory, even on a text endpoint.
const CRAWLER_RE = /bot\b|crawler|spider|scraper|headless|preview|monitor|slurp|archive/i;
// The legitimate audience for a terminal ad: shell fetchers and CLIs. The
// generic tracker (lib/tracker/device) buckets all of these as "bot", which is
// right for a web page and exactly wrong here — on /api/ads/motd, curl IS the
// human. Misclassifying them means a terminal slot can only ever serve house
// ads and never earns.
const CLI_RE = /curl|wget|httpie|libwww|lwp|python-requests|go-http|node-fetch|powershell|http-client|axios|fetch|motd|ssh/i;

/**
 * Device bucket for a terminal ad request. Returns "bot" for real crawlers,
 * "terminal" for shell clients (and for a missing UA, which curl-ish tooling
 * often omits), otherwise falls through to the caller's own classification by
 * returning null.
 */
export function terminalDeviceType(userAgent: string | null | undefined): string | null {
  const ua = (userAgent ?? "").trim();
  if (!ua) return "terminal";
  if (CRAWLER_RE.test(ua)) return "bot";
  if (CLI_RE.test(ua)) return "terminal";
  return null;
}

// --- ANSI ------------------------------------------------------------------

const ESC = "\x1b";
const RESET = `${ESC}[0m`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;

function fg(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex ?? "").trim());
  if (!m) return "";
  const n = parseInt(m[1], 16);
  return `${ESC}[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
}

// --- Layout ----------------------------------------------------------------

// "+-- LABEL ---------+" / "+--------- LABEL --+". Label is optional; the
// border is always exactly `cols` characters wide.
function border(cols: number, label: string | null, align: "left" | "right"): string {
  const inner = cols - 2; // between the two '+'
  if (!label) return `+${"-".repeat(inner)}+`;
  const tag = ` ${label} `;
  const dashes = Math.max(0, inner - tag.length - 2);
  return align === "left"
    ? `+--${tag}${"-".repeat(dashes)}+`
    : `+${"-".repeat(dashes)}${tag}--+`;
}

/**
 * Render a creative as a self-contained ASCII block.
 *
 * `clickUrl` is printed verbatim so it stays copy-pasteable - if it can't fit
 * inside the box it gets its own line below the frame rather than being
 * truncated into a dead link.
 */
export function renderCreativeText(
  creative: AdCreative,
  clickUrl: string,
  opts: TerminalRenderOpts = {},
): string {
  const cols = clampCols(opts.cols);
  const color = opts.color === true;
  const inner = cols - 4; // "| " + " |"

  const headline = sanitizeTerminalText(creative.headline) || "Sponsored";
  const body = sanitizeTerminalText(creative.body);
  // Copy often already ends in an arrow ("Advertise ->"); we add our own, so
  // strip a trailing one rather than printing "Advertise ->:".
  const cta =
    sanitizeTerminalText(creative.ctaText).replace(/\s*(->|>|:)\s*$/, "").trim() || "Learn more";
  // The click URL is ours (never advertiser-authored), but sanitize anyway so a
  // malformed destination can't smuggle an escape sequence through.
  const url = sanitizeTerminalText(clickUrl).replace(/\s/g, "");

  const accent = color ? fg(creative.accentColor) : "";
  const body_ = color ? fg(creative.fgColor) : "";
  const off = color ? RESET : "";

  const rows: string[] = [];
  const pipe = color ? `${accent}|${off}` : "|";
  const row = (content: string, visibleLen: number) =>
    rows.push(`${pipe} ${content}${" ".repeat(Math.max(0, inner - visibleLen))} ${pipe}`);
  const blank = () => row("", 0);

  blank();
  for (const l of wrapText(headline, inner)) {
    row(color ? `${BOLD}${body_}${l}${off}` : l, l.length);
  }
  if (body) {
    for (const l of wrapText(body, inner)) {
      row(color ? `${body_}${l}${off}` : l, l.length);
    }
  }
  blank();

  // "Try it free -> https://..." on one line when it fits, else CTA then URL.
  const oneLine = `${cta} -> ${url}`;
  const overflow: string[] = [];
  if (oneLine.length <= inner) {
    row(color ? `${accent}${cta} ->${off} ${body_}${url}${off}` : oneLine, oneLine.length);
  } else if (url.length <= inner) {
    row(color ? `${accent}${cta}:${off}` : `${cta}:`, cta.length + 1);
    row(color ? `${body_}${url}${off}` : url, url.length);
  } else {
    // Pathologically long URL: keep it whole, outside the frame.
    row(color ? `${accent}${cta}:${off}` : `${cta}:`, cta.length + 1);
    overflow.push(color ? `${body_}${url}${off}` : url);
  }
  blank();

  const top = border(cols, opts.label ?? SPONSORED_LABEL, "left");
  const bottom = border(cols, ATTRIBUTION, "right");
  return [
    color ? `${accent}${top}${off}` : top,
    ...rows,
    color ? `${DIM}${accent}${bottom}${off}` : bottom,
    ...overflow,
  ].join("\n");
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Browser rendering of the terminal format: the exact same ASCII, in a
 * monospace <pre>. Lets the terminal creative still fill a normal web slot
 * (and the /api/ads/frame iframe) without needing a separate design.
 */
export function renderTerminalHtml(creative: AdCreative, clickUrl: string): string {
  const artwork = renderCreativeText(creative, clickUrl, { color: false });
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box;margin:0}
    a{text-decoration:none;display:block}
    .cp-ad{background:${creative.bgColor};color:${creative.fgColor};border-radius:8px;
      border:1px solid rgba(255,255,255,.08);padding:10px 12px;overflow:auto}
    pre{margin:0;font:12px/1.35 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
      white-space:pre;color:${creative.fgColor}}
  </style></head><body>
    <a class="cp-ad" href="${esc(clickUrl)}" target="_blank" rel="noopener sponsored"><pre>${esc(artwork)}</pre></a>
  </body></html>`;
}
