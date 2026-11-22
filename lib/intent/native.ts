// Free, keyless native search for Buyer Intent: Hacker News (Algolia), Stack
// Overflow (Stack Exchange API) and GitHub issues. These run on every sweep,
// so a watch still finds leads when the paid SERP provider is out of credits,
// and they carry real timestamps instead of "3 days ago" strings.
//
// Reddit is not here: reddit.com blocks server IPs and Arctic Shift's search
// times out under load, so Reddit stays on the SERP path.

import { scoreIntent } from "@/lib/outreach/intent";
import type { IntentHit } from "@/lib/outreach/intentSources";

export const NATIVE_SOURCES = [
  { id: "hn", label: "Hacker News", group: "forums" },
  { id: "stackoverflow", label: "Stack Overflow", group: "forums" },
  { id: "github", label: "GitHub issues", group: "github" },
] as const;

const TIMEOUT_MS = 12_000;
const UA = "CrawlProof-BuyerIntent/1.0 (+https://crawlproof.com/products)";

function strip(html: string | null | undefined): string {
  return (html ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "application/json", ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

type Raw = { source: string; url: string; title: string; snippet: string; postedAt: Date | null; body?: string };

async function searchHN(term: string, sinceSec: number): Promise<Raw[]> {
  // Exact phrase, no typo tolerance: Algolia's default fuzzy/prefix matching
  // returned 30 of 30 posts that never contained the term ("CRM" matched
  // 26,593 posts in a week), and the scorer rightly dropped every one.
  const q = encodeURIComponent(`"${term.replace(/"/g, "")}"`);
  const d = (await getJson(
    `https://hn.algolia.com/api/v1/search_by_date?query=${q}&tags=(story,comment,ask_hn)&numericFilters=created_at_i>${sinceSec}&hitsPerPage=50&typoTolerance=false&advancedSyntax=true`,
  )) as { hits?: Array<Record<string, unknown>> };
  return (d.hits ?? []).map((h) => {
    const id = String(h.objectID);
    const body = strip((h.comment_text as string) ?? (h.story_text as string));
    const title = (h.title as string) ?? (h.story_title ? `Re: ${h.story_title as string}` : "");
    return {
      source: "hn",
      url: `https://news.ycombinator.com/item?id=${id}`,
      title: strip(title),
      snippet: body.slice(0, 600),
      body: body.slice(0, 8000),
      postedAt: typeof h.created_at_i === "number" ? new Date(h.created_at_i * 1000) : null,
    };
  });
}

async function searchStackOverflow(term: string, sinceSec: number): Promise<Raw[]> {
  const q = encodeURIComponent(term);
  const d = (await getJson(
    `https://api.stackexchange.com/2.3/search/excerpts?q=${q}&site=stackoverflow&sort=creation&order=desc&pagesize=30&fromdate=${sinceSec}`,
  )) as { items?: Array<Record<string, unknown>> };
  return (d.items ?? []).map((i) => ({
    source: "stackoverflow",
    url:
      i.item_type === "answer"
        ? `https://stackoverflow.com/a/${String(i.answer_id)}`
        : `https://stackoverflow.com/q/${String(i.question_id)}`,
    title: strip(i.title as string),
    snippet: strip((i.excerpt as string) ?? (i.body as string)).slice(0, 600),
    body: strip((i.body as string) ?? (i.excerpt as string)).slice(0, 8000),
    postedAt: typeof i.creation_date === "number" ? new Date(i.creation_date * 1000) : null,
  }));
}

async function searchGitHub(term: string, since: Date): Promise<Raw[]> {
  const q = encodeURIComponent(`"${term}" is:issue created:>${since.toISOString().slice(0, 10)}`);
  const d = (await getJson(`https://api.github.com/search/issues?q=${q}&sort=created&order=desc&per_page=30`, {
    accept: "application/vnd.github+json",
  })) as { items?: Array<Record<string, unknown>> };
  return (d.items ?? []).map((i) => ({
    source: "github",
    url: String(i.html_url),
    title: String(i.title ?? ""),
    snippet: strip(i.body as string).slice(0, 600),
    body: strip(i.body as string).slice(0, 8000),
    postedAt: i.created_at ? new Date(String(i.created_at)) : null,
  }));
}

export type NativeSweep = { hits: IntentHit[]; calls: number; notes: string[] };

/**
 * Search the native sources for each term. `calls` counts searches that
 * actually returned, so the caller only charges for a sweep that searched.
 */
export async function sweepNative(input: {
  terms: string[];
  keywords: string[];
  negativeKeywords?: string[];
  sources?: string[];
  days: number;
  minIntent: number;
  now?: Date;
}): Promise<NativeSweep> {
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - input.days * 86_400_000);
  const sinceSec = Math.floor(since.getTime() / 1000);
  const want = (id: string, group: string) =>
    !input.sources?.length || input.sources.includes(id) || input.sources.includes(group);
  const searches: Array<[string, (t: string) => Promise<Raw[]>]> = [];
  if (want("hn", "forums")) searches.push(["Hacker News", (t) => searchHN(t, sinceSec)]);
  if (want("stackoverflow", "forums")) searches.push(["Stack Overflow", (t) => searchStackOverflow(t, sinceSec)]);
  if (want("github", "github")) searches.push(["GitHub", (t) => searchGitHub(t, since)]);

  const notes: string[] = [];
  const seen = new Set<string>();
  const hits: IntentHit[] = [];
  let calls = 0;
  const jobs = input.terms.slice(0, 6).flatMap((term) => searches.map(([label, fn]) => ({ label, term, fn })));
  const results = await Promise.allSettled(jobs.map((j) => j.fn(j.term)));
  results.forEach((r, i) => {
    const j = jobs[i];
    if (r.status === "rejected") {
      notes.push(`${j.label} "${j.term}": ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
      return;
    }
    calls += 1;
    for (const raw of r.value) {
      if (!raw.url || seen.has(raw.url)) continue;
      seen.add(raw.url);
      const signal = scoreIntent({
        // Score the whole post: the buying phrase is often past the snippet.
        text: `${raw.title}\n${raw.body ?? raw.snippet}`,
        postedAt: raw.postedAt,
        keywords: input.keywords,
        negativeKeywords: input.negativeKeywords,
        now,
      });
      if (signal.disqualified || signal.score < input.minIntent) continue;
      hits.push({ source: raw.source, url: raw.url, title: raw.title, snippet: raw.snippet, postedAt: raw.postedAt, signal });
    }
  });
  notes.push(`native: ${hits.length} signals from ${calls} free searches`);
  return { hits, calls, notes };
}
