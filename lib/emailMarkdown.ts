/**
 * Markdown (or plain text) -> email-safe HTML, styled for the CrawlProof email shell.
 *
 * Zero dependencies and no server-only APIs, so the admin broadcast preview and the
 * send route render through the exact same code — what the admin sees is what ships.
 *
 * All input is HTML-escaped first, so pasted markup is shown literally instead of being
 * injected, and only http/https/mailto/tel URLs survive in links and images.
 *
 * Plain text is handled by treating a single newline as a line break, so a pasted
 * paragraph keeps its shape without any markdown at all.
 *
 * Colours target the dark shell in lib/email.ts (background #12161c). The preview in
 * the admin form renders on the same background for that reason.
 */

/** Inline styles, because several email clients drop <style> blocks. */
const S: Record<string, string> = {
  p: "margin:0 0 16px;font-size:14px;line-height:1.7;color:#c3cad6;",
  h1: "margin:24px 0 12px;font-size:22px;line-height:1.3;font-weight:800;color:#e7e9ee;",
  h2: "margin:24px 0 12px;font-size:18px;line-height:1.3;font-weight:700;color:#e7e9ee;",
  h3: "margin:20px 0 10px;font-size:16px;line-height:1.4;font-weight:700;color:#e7e9ee;",
  h4: "margin:20px 0 10px;font-size:14px;line-height:1.4;font-weight:700;color:#e7e9ee;",
  h5: "margin:16px 0 8px;font-size:13px;line-height:1.4;font-weight:700;color:#e7e9ee;",
  h6: "margin:16px 0 8px;font-size:12px;line-height:1.4;font-weight:700;color:#9aa3b2;",
  ul: "margin:0 0 16px;padding-left:22px;",
  ol: "margin:0 0 16px;padding-left:22px;",
  li: "margin:0 0 8px;font-size:14px;line-height:1.7;color:#c3cad6;",
  blockquote:
    "margin:0 0 16px;padding:8px 16px;border-left:3px solid #6ee7b7;background:#0f1319;color:#9aa3b2;",
  pre: "margin:0 0 16px;padding:12px 14px;background:#0b0d10;border:1px solid #1f2630;border-radius:8px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;line-height:1.5;color:#c3cad6;white-space:pre-wrap;word-break:break-word;",
  code: "padding:2px 5px;background:#0b0d10;border:1px solid #1f2630;border-radius:4px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;color:#e7e9ee;",
  a: "color:#6ee7b7;text-decoration:underline;",
  hr: "border:none;border-top:1px solid #1f2630;margin:24px 0;",
  img: "max-width:100%;height:auto;border-radius:8px;",
};

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const FENCE = /^[ \t]{0,3}(```|~~~)/;
const HEADING = /^[ \t]{0,3}(#{1,6})[ \t]+(.*?)\s*#*\s*$/;
const HR = /^[ \t]{0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;
const QUOTE = /^[ \t]{0,3}>/;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Returns an href-safe URL, or null when the scheme is not allowed. */
function safeUrl(raw: string): string | null {
  const url = raw.trim().replace(/^&lt;/, "").replace(/&gt;$/, "");
  if (/^(https?:\/\/|mailto:|tel:)/i.test(url)) return url;
  if (/^www\./i.test(url)) return `https://${url}`;
  return null;
}

function indentOf(line: string): number {
  const m = line.match(/^\s*/);
  return m ? m[0].replace(/\t/g, "    ").length : 0;
}

function isBlockStart(line: string): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    HR.test(line) ||
    QUOTE.test(line) ||
    LIST_ITEM.test(line)
  );
}

/** Removes the common leading indentation from a block of continuation lines. */
function dedent(lines: string[]): string[] {
  const filled = lines.filter((l) => l.trim());
  if (filled.length === 0) return lines;
  const min = Math.min(...filled.map(indentOf));
  return lines.map((l) => (l.trim() ? l.slice(min) : ""));
}

/**
 * Renders inline markdown. Links, images and code spans are swapped for placeholders
 * before emphasis runs, so generated markup (hrefs especially) is never re-parsed.
 */
function renderInline(text: string): string {
  const parked: string[] = [];
  const park = (html: string): string => `\u0000${parked.push(html) - 1}\u0000`;

  let s = escapeHtml(text);

  // Code spans first: nothing inside them should be interpreted.
  s = s.replace(/(`+)([^`]+?)\1/g, (_m, _ticks, code: string) =>
    park(`<code style="${S.code}">${code.trim()}</code>`),
  );

  // Images: ![alt](src "title")
  s = s.replace(
    /!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\s*\)/g,
    (m, alt: string, url: string) => {
      const href = safeUrl(url);
      return href
        ? park(`<img src="${href}" alt="${alt}" style="${S.img}" />`)
        : m;
    },
  );

  // Links: [label](href "title")
  s = s.replace(
    /\[([^\]]+)\]\(\s*([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\s*\)/g,
    (m, label: string, url: string) => {
      const href = safeUrl(url);
      return href ? park(`<a href="${href}" style="${S.a}">${label}</a>`) : m;
    },
  );

  // Bare URLs and email addresses.
  s = s.replace(
    /(^|[\s(])((?:https?:\/\/|www\.)[^\s<>()]+)/g,
    (_m, pre: string, url: string) => {
      const trimmed = url.replace(/[.,;:!?]+$/, "");
      const href = safeUrl(trimmed);
      if (!href) return `${pre}${url}`;
      const tail = url.slice(trimmed.length);
      return `${pre}${park(`<a href="${href}" style="${S.a}">${trimmed}</a>`)}${tail}`;
    },
  );
  s = s.replace(
    /(^|[\s(])([A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g,
    (_m, pre: string, addr: string) =>
      `${pre}${park(`<a href="mailto:${addr}" style="${S.a}">${addr}</a>`)}`,
  );

  // Emphasis. Bold before italic so ** is not eaten by *.
  s = s.replace(/\*\*([^\n]+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^\w\\])__([^\n]+?)__(?!\w)/g, "$1<strong>$2</strong>");
  s = s.replace(/\*([^*\n]+?)\*/g, "<em>$1</em>");
  s = s.replace(/(^|[^\w\\])_([^_\n]+?)_(?!\w)/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~\n]+?)~~/g, "<del>$1</del>");

  return s.replace(
    /\u0000(\d+)\u0000/g,
    (_m, i: string) => parked[Number(i)] ?? "",
  );
}

function renderList(
  lines: string[],
  start: number,
  indent: number,
): [string, number] {
  const first = lines[start].match(LIST_ITEM) as RegExpMatchArray;
  const ordered = /\d/.test(first[2]);
  const items: { head: string; rest: string[] }[] = [];
  let i = start;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      // A blank line only continues the list if indented content or another item follows.
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      if (j >= lines.length) break;
      const next = lines[j];
      const nextIsItem = LIST_ITEM.test(next);
      if (indentOf(next) > indent) {
        if (items.length) items[items.length - 1].rest.push("");
        i = j;
        continue;
      }
      if (nextIsItem && indentOf(next) <= indent) {
        i = j;
        continue;
      }
      break;
    }

    const m = line.match(LIST_ITEM);
    const li = indentOf(line);

    if (m && li <= indent) {
      if (/\d/.test(m[2]) !== ordered) break; // ul -> ol (or back) starts a new list
      items.push({ head: m[3], rest: [] });
      i++;
      continue;
    }

    if (items.length && li > indent) {
      items[items.length - 1].rest.push(line);
      i++;
      continue;
    }

    break;
  }

  const html = items
    .map(({ head, rest }) => {
      const body = dedent(rest);
      const lead = [head];
      let k = 0;
      while (k < body.length && body[k].trim() && !isBlockStart(body[k])) {
        lead.push(body[k].trim());
        k++;
      }
      const tail = renderBlocks(body.slice(k));
      return `<li style="${S.li}">${lead.map(renderInline).join("<br />")}${tail ? `\n${tail}` : ""}</li>`;
    })
    .join("\n");

  const tag = ordered ? "ol" : "ul";
  return [`<${tag} style="${S[tag]}">\n${html}\n</${tag}>`, i];
}

function renderBlocks(lines: string[]): string {
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = line.match(FENCE);
    if (fence) {
      const marker = fence[1];
      const body: string[] = [];
      i++;
      while (
        i < lines.length &&
        !new RegExp(`^[ \\t]{0,3}${marker}[ \\t]*$`).test(lines[i])
      ) {
        body.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // closing fence
      out.push(
        `<pre style="${S.pre}"><code>${escapeHtml(body.join("\n"))}</code></pre>`,
      );
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      const level = heading[1].length;
      out.push(
        `<h${level} style="${S[`h${level}`]}">${renderInline(heading[2])}</h${level}>`,
      );
      i++;
      continue;
    }

    if (HR.test(line)) {
      out.push(`<hr style="${S.hr}" />`);
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        body.push(lines[i].replace(/^[ \t]{0,3}>[ \t]?/, ""));
        i++;
      }
      out.push(
        `<blockquote style="${S.blockquote}">\n${renderBlocks(body)}\n</blockquote>`,
      );
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const [html, next] = renderList(lines, i, indentOf(line));
      out.push(html);
      i = next;
      continue;
    }

    // Paragraph: consecutive text lines, single newlines kept as <br> for plain text.
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
      para.push(lines[i].trim());
      i++;
    }
    out.push(`<p style="${S.p}">${para.map(renderInline).join("<br />")}</p>`);
  }

  return out.join("\n");
}

/**
 * Converts markdown (or plain text) into the HTML fragment that goes inside an email
 * body. The output is escaped and inline-styled; it is not a full HTML document.
 */
export function markdownToEmailHtml(input: string): string {
  if (!input || !input.trim()) return "";
  const lines = input
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ")
    .split("\n");
  return renderBlocks(lines);
}

/** Readable text/plain alternative: markdown syntax stripped, structure preserved. */
export function markdownToPlainText(input: string): string {
  if (!input) return "";
  return input
    .replace(/\r\n?/g, "\n")
    .replace(/^[ \t]{0,3}(?:```|~~~).*$/gm, "")
    .replace(/^[ \t]{0,3}(#{1,6})[ \t]+/gm, "")
    .replace(/^(\s*)([*+])\s+/gm, "$1- ")
    .replace(/!\[([^\]]*)\]\(\s*([^)\s]+)[^)]*\)/g, "$1 ($2)")
    .replace(/\[([^\]]+)\]\(\s*([^)\s]+)[^)]*\)/g, "$1 ($2)")
    .replace(/`+([^`]+?)`+/g, "$1")
    .replace(/\*\*([^\n]+?)\*\*/g, "$1")
    .replace(/(^|[^\w\\])__([^\n]+?)__(?!\w)/g, "$1$2")
    .replace(/\*([^*\n]+?)\*/g, "$1")
    .replace(/(^|[^\w\\])_([^_\n]+?)_(?!\w)/g, "$1$2")
    .replace(/~~([^~\n]+?)~~/g, "$1")
    .replace(/^[ \t]{0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/gm, "---")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
