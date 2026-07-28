// Where public buying intent gets expressed, and how to go and read it.
//
// Reddit is the obvious one and the one this codebase already talks to
// natively, but it is not the only place somebody says "we need X, who should
// we pay". The same sentence turns up on Hacker News, Stack Exchange, Quora,
// X, LinkedIn, Mastodon, Indie Hackers and a long tail of forums — and a
// pipeline that only watches one of them inherits that one community's
// demographics as its entire market.
//
// Everything except Reddit is read through the search index rather than a
// platform API. That is a deliberate trade: platform APIs mean per-platform
// auth, per-platform rate limits, per-platform review processes and a
// per-platform reason to break, and the search index already crawls all of
// them with a date filter attached. It costs one SERP call per site per run
// and needs no credentials at all.
//
// The honest limitation, stated here because it decides how the results should
// be read: a search index lags. Something posted twenty minutes ago may not be
// indexed yet, so this finds hours-old intent reliably and minutes-old intent
// only sometimes. Reddit's own API does not have that lag, which is why it
// stays a first-class source rather than another site: filter.

import { searchSerp } from "@/lib/alerts/valueserp";
import { scoreIntent, type IntentSignal } from "./intent";

export type IntentSource = {
  id: string;
  label: string;
  /** Domains to restrict a search to. */
  sites: string[];
  /** Off by default when a platform rewards volume over relevance. */
  defaultOn: boolean;
};

/**
 * The places worth watching, and why each is on the list.
 *
 * Ordered by how often people state a budget outright. Q&A sites and founder
 * communities do it constantly; the big social networks do it rarely but at
 * enough volume to be worth one call.
 */
export const INTENT_SOURCES: IntentSource[] = [
  {
    id: "reddit",
    label: "Reddit",
    sites: ["reddit.com"],
    defaultOn: true,
  },
  {
    id: "forums",
    label: "Q&A and developer forums",
    sites: ["news.ycombinator.com", "stackexchange.com", "serverfault.com", "superuser.com"],
    defaultOn: true,
  },
  {
    id: "founders",
    label: "Founder and indie communities",
    sites: ["indiehackers.com", "producthunt.com", "lobste.rs"],
    defaultOn: true,
  },
  {
    id: "quora",
    label: "Quora",
    sites: ["quora.com"],
    defaultOn: true,
  },
  {
    id: "x",
    label: "X",
    sites: ["x.com", "twitter.com"],
    // Public search coverage of X is patchy since the API changes, so it is
    // on but expected to be thin rather than reliable.
    defaultOn: true,
  },
  {
    id: "linkedin",
    label: "LinkedIn",
    sites: ["linkedin.com"],
    defaultOn: true,
  },
  {
    id: "mastodon",
    label: "Mastodon and Bluesky",
    sites: ["mastodon.social", "bsky.app"],
    defaultOn: false,
  },
  {
    id: "jobs",
    label: "Job and contract boards",
    // A job ad for the thing you sell is a budget that has already been
    // approved — it is intent wearing different clothes.
    sites: ["upwork.com", "weworkremotely.com", "remoteok.com"],
    defaultOn: false,
  },
];

/**
 * Search phrasings that find a request rather than an article about one.
 *
 * A bare topic search returns listicles and vendor pages; these return people
 * talking. Each is combined with the campaign's own topic words.
 */
export const INTENT_PHRASINGS = [
  '"anyone recommend"',
  '"looking for a"',
  '"any recommendations"',
  '"willing to pay"',
  '"alternatives to"',
  '"what do you use"',
];

export type IntentHit = {
  source: string;
  url: string;
  title: string;
  snippet: string;
  /** Parsed from the result where the index reports one. */
  postedAt: Date | null;
  signal: IntentSignal;
};

/**
 * Turn the date a search index reports into a timestamp.
 *
 * Indexes report these inconsistently — an absolute date on one result and "3
 * days ago" on the next — and a relative string is still worth parsing,
 * because recency is the half of the score that a stale-but-strong post gets
 * wrong.
 */
export function parseResultDate(raw: string | null | undefined, now = new Date()): Date | null {
  if (!raw) return null;
  const text = raw.trim();

  const relative = text.match(/(\d+)\s*(minute|hour|day|week|month|year)s?\s+ago/i);
  if (relative) {
    const n = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    const ms =
      unit === "minute" ? 60_000
      : unit === "hour" ? 3_600_000
      : unit === "day" ? 86_400_000
      : unit === "week" ? 604_800_000
      : unit === "month" ? 2_592_000_000
      : 31_536_000_000;
    return new Date(now.getTime() - n * ms);
  }

  const parsed = Date.parse(text);
  if (!Number.isNaN(parsed)) {
    const d = new Date(parsed);
    // A date in the future is the index misreporting, not a scoop.
    return d.getTime() > now.getTime() + 86_400_000 ? null : d;
  }
  return null;
}

/** One search string per source, combining the topic with a request phrasing. */
export function buildIntentQuery(input: {
  source: IntentSource;
  topic: string;
  phrasing: string;
}): string {
  const sites = input.source.sites.map((s) => `site:${s}`).join(" OR ");
  return `(${sites}) ${input.topic} ${input.phrasing}`;
}

export type IntentSweepResult = {
  hits: IntentHit[];
  /** SERP calls actually spent, for the caller's budget. */
  calls: number;
  notes: string[];
};

/**
 * Sweep the enabled sources for people asking to buy.
 *
 * Bounded by an explicit call budget rather than by the number of sources, so
 * adding a platform to the list above cannot quietly multiply what a run
 * costs.
 */
export async function sweepIntent(input: {
  topic: string;
  keywords: string[];
  negativeKeywords?: string[];
  sources?: string[];
  /** Maximum SERP calls this sweep may spend. */
  maxCalls: number;
  /** Only consider posts newer than this. */
  recency?: "day" | "week" | "month";
  minIntent?: number;
  now?: Date;
}): Promise<IntentSweepResult> {
  const now = input.now ?? new Date();
  const enabled = INTENT_SOURCES.filter((s) =>
    input.sources?.length ? input.sources.includes(s.id) : s.defaultOn,
  );
  const notes: string[] = [];
  const seen = new Set<string>();
  const hits: IntentHit[] = [];
  let calls = 0;

  // One phrasing at a time across every source, rather than every phrasing on
  // the first source — so a small budget still covers the whole list instead
  // of exhausting itself on Reddit.
  outer: for (const phrasing of INTENT_PHRASINGS) {
    for (const source of enabled) {
      if (calls >= input.maxCalls) {
        notes.push(`stopped at the ${input.maxCalls}-search budget`);
        break outer;
      }
      const res = await searchSerp({
        query: buildIntentQuery({ source, topic: input.topic, phrasing }),
        recency: input.recency ?? "week",
        num: 20,
      });
      calls += res.calls;
      if (!res.ok) {
        notes.push(`${source.label}: ${res.error ?? "search failed"}`);
        continue;
      }

      for (const r of res.results) {
        if (!r.url || seen.has(r.url)) continue;
        seen.add(r.url);
        const postedAt = parseResultDate(r.date, now);
        const signal = scoreIntent({
          // Title and snippet are all the index gives; it is also roughly what
          // a human skims before deciding whether to open the thread.
          text: `${r.title ?? ""}\n${r.snippet ?? ""}`,
          postedAt,
          keywords: input.keywords,
          negativeKeywords: input.negativeKeywords,
          now,
        });
        if (signal.disqualified) continue;
        if (signal.score < (input.minIntent ?? 0)) continue;
        hits.push({
          source: source.id,
          url: r.url,
          title: r.title ?? "",
          snippet: r.snippet ?? "",
          postedAt,
          signal,
        });
      }
    }
  }

  // Strongest and freshest first — the score already folds both in, so this is
  // simply the order to work them in.
  hits.sort((a, b) => b.signal.score - a.signal.score);
  notes.push(`${hits.length} intent signals from ${enabled.length} sources in ${calls} searches`);
  return { hits, calls, notes };
}
