"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  createOrUpdateSite,
  detectSitemap,
  discoverFromHomepage,
  enrichFromUrls,
  generateSchedule,
  previewNow,
  suggestLongTailKeywords,
} from "@/app/actions/linkExchange";

type WizardStep = "discover" | "confirm" | "review";

type Existing = {
  id: string;
  domain: string;
  blog_root_url: string;
  sitemap_url: string;
  niche: string | null;
  target_audiences: string[];
  description: string;
  seed_keywords: string[];
  modifiers: string[];
  preserve_keywords: boolean;
  keywords: string[];
  seo_title: string | null;
  seo_description: string | null;
  tone: string | null;
  competitors: string[];
  webhook_url: string | null;
  webhook_secret: string | null;
  daily_article_count: number;
  publish_days: number[];
  publish_hour: number;
  internal_links_per_article: number;
  backlinks_enabled: boolean;
  external_links_per_article: number;
  banner_style: string | null;
  status: string;
};

const BANNER_STYLE_OPTIONS: Array<{ value: string; label: string; hint: string }> = [
  { value: "editorial", label: "Editorial photo", hint: "Cinematic photojournalistic cover" },
  { value: "hype", label: "Marketing hype", hint: "Bold, energetic launch-poster look" },
  { value: "concept", label: "Concept illustration", hint: "Clean illustrated metaphor of the idea" },
  { value: "tech", label: "3D / isometric", hint: "Sleek 3D render of the topic" },
  { value: "bold_type", label: "Bold minimal", hint: "Striking minimal composition" },
];

const DAY_LABELS: Array<{ n: number; label: string }> = [
  { n: 1, label: "Mon" },
  { n: 2, label: "Tue" },
  { n: 3, label: "Wed" },
  { n: 4, label: "Thu" },
  { n: 5, label: "Fri" },
  { n: 6, label: "Sat" },
  { n: 7, label: "Sun" },
];

type ApiResult = { ok: boolean; error?: string; message?: string };
type Operation = "sitemap" | "keywords" | "regenerate";

async function callOperation(path: string): Promise<ApiResult> {
  try {
    const res = await fetch(path, { method: "POST" });
    const json = await res.json().catch(() => ({}));
    return {
      ok: res.ok && json?.ok !== false,
      error: json?.error,
      message: json?.message,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function SetupForm({
  projectId,
  initial,
  initialQueuedCount,
  initialFailedCount,
  initialKeywordFailure,
}: {
  projectId: string;
  initial: Existing | null;
  initialQueuedCount: number;
  initialFailedCount: number;
  initialKeywordFailure: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  // Wizard state — for new sites we run a 3-step discover → confirm →
  // review flow. For existing sites we jump straight to review.
  const [step, setStep] = useState<WizardStep>(initial ? "review" : "discover");
  const [homepageUrl, setHomepageUrl] = useState("");
  const [discovering, setDiscovering] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [feedUrl, setFeedUrl] = useState("");

  const [domain, setDomain] = useState(initial?.domain ?? "");
  const [blogRoot, setBlogRoot] = useState(initial?.blog_root_url ?? "");
  const [sitemap, setSitemap] = useState(initial?.sitemap_url ?? "");
  const [niche, setNiche] = useState(initial?.niche ?? "");
  const [audiences, setAudiences] = useState(
    (initial?.target_audiences ?? []).join(", "),
  );
  const [description, setDescription] = useState(initial?.description ?? "");
  const [seedKeywords, setSeedKeywords] = useState(
    (initial?.seed_keywords ?? []).join(", "),
  );
  const [modifiers, setModifiers] = useState(
    (initial?.modifiers ?? []).join(", "),
  );
  const [preserveKeywords, setPreserveKeywords] = useState<boolean>(
    initial?.preserve_keywords ?? false,
  );
  const [keywords, setKeywords] = useState(
    (initial?.keywords ?? []).join("\n"),
  );
  const [seoTitle, setSeoTitle] = useState(initial?.seo_title ?? "");
  const [seoDescription, setSeoDescription] = useState(initial?.seo_description ?? "");
  const [tone, setTone] = useState(initial?.tone ?? "");
  const [bannerStyle, setBannerStyle] = useState(initial?.banner_style ?? "editorial");
  const [competitors, setCompetitors] = useState(
    (initial?.competitors ?? []).join(", "),
  );
  const [webhookUrl, setWebhookUrl] = useState(initial?.webhook_url ?? "");
  const [webhookSecret, setWebhookSecret] = useState<string>(
    initial?.webhook_secret ?? "",
  );
  const [dailyCount, setDailyCount] = useState<number>(
    initial?.daily_article_count ?? 1,
  );
  const [days, setDays] = useState<number[]>(
    initial?.publish_days ?? [1, 2, 3, 4, 5],
  );
  const [publishHour, setPublishHour] = useState<number>(
    initial?.publish_hour ?? 9,
  );
  const [internalLinks, setInternalLinks] = useState<number>(
    initial?.internal_links_per_article ?? 3,
  );
  const [backlinksEnabled, setBacklinksEnabled] = useState<boolean>(
    initial?.backlinks_enabled ?? false,
  );
  const [externalLinks, setExternalLinks] = useState<number>(
    initial?.external_links_per_article ?? 3,
  );

  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [autoFilling, setAutoFilling] = useState(false);
  const lastAutoFilledDomain = useRef<string | null>(null);
  const [queuedCount, setQueuedCount] = useState(initialQueuedCount);
  const [failedCount, setFailedCount] = useState(initialFailedCount);
  const [keywordFailure, setKeywordFailure] = useState(initialKeywordFailure);
  const [operation, setOperation] = useState<Operation | null>(null);

  function normalizeDomainInput(raw: string): string {
    return raw
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split("/")[0];
  }

  function onDomainBlur() {
    if (!domain) return;
    const host = normalizeDomainInput(domain);
    if (!blogRoot) setBlogRoot(`https://${host}/blog`);
    // Kick the auto-fill chain. It's idempotent per-host, so editing
    // the domain back to a value we already filled is a no-op.
    void autoFillFromDomain();
  }

  // Chained auto-population: sitemap detect → blog enrichment →
  // search-volume lookup. Runs whenever the domain is set and we
  // haven't already auto-filled for that exact domain. The wizard's
  // confirm step also triggers this implicitly by setting the domain.
  async function autoFillFromDomain(force = false) {
    const host = normalizeDomainInput(domain);
    if (!host) return;
    if (!force && lastAutoFilledDomain.current === host) return;
    lastAutoFilledDomain.current = host;

    setError(null);
    setWarning(null);
    setNotice(null);
    setAutoFilling(true);

    const ensureBlogRoot = blogRoot.trim() || `https://${host}/blog`;
    if (!blogRoot.trim()) setBlogRoot(ensureBlogRoot);

    // 1. Sitemap detect — only if the field is empty.
    let resolvedSitemap = sitemap.trim();
    if (!resolvedSitemap) {
      const sm = await detectSitemap(host);
      if (sm.ok && sm.sitemapUrl) {
        resolvedSitemap = sm.sitemapUrl;
        setSitemap(sm.sitemapUrl);
      }
    }

    // 2. Editorial enrichment via the configured backend text provider.
    setEnriching(true);
    const enrich = await enrichFromUrls({
      blogUrl: ensureBlogRoot,
      feedUrl: feedUrl.trim() || null,
      sitemapUrl: resolvedSitemap || null,
    });
    setEnriching(false);
    if (!enrich.ok) {
      setWarning(
        `Couldn't auto-write your editorial profile (${enrich.error}). Fill the niche, audiences, and description by hand.`,
      );
      setAutoFilling(false);
      return;
    }
    applyProfile(enrich.profile);

    // 3. DataForSEO Labs keyword_ideas expansion. We feed it the model's
    // BROAD seed_keywords (3-6 head terms like "web security") and let
    // DFS fan out into hundreds of related long-tail phrases — one
    // blog wants a fat keyword list, not 5-15. The narrower
    // `keywords` field is a fallback when no seeds came back.
    const expansionSeeds =
      enrich.profile.seedKeywords.length > 0
        ? enrich.profile.seedKeywords
        : enrich.profile.keywords;

    // Preserve gate — if the user has hand-curated their keyword list
    // and ticked the box, skip the DFS call entirely. Editorial fields
    // (niche, audiences, description, seeds, etc.) still get refreshed.
    if (preserveKeywords) {
      setNotice(
        "Auto-filled editorial. Seeds + long-tail preserved (uncheck to overwrite).",
      );
      setAutoFilling(false);
      return;
    }

    setSuggesting(true);
    const traffic = await suggestLongTailKeywords(expansionSeeds);
    setSuggesting(false);
    if (traffic.ok && traffic.suggestions.length > 0) {
      setKeywords(
        traffic.suggestions.map((s) => `${s.keyword},${s.searchVolume}`).join("\n"),
      );
      setNotice(`Auto-filled — ${traffic.tier}.`);
    } else if (traffic.ok) {
      setNotice("Auto-filled. No long-tail keywords met the traffic threshold.");
    } else {
      setWarning(`Editorial filled, but keyword expansion failed (${traffic.error}).`);
    }

    setAutoFilling(false);
  }

  // Trigger auto-fill on mount when we land on the review step with
  // an existing domain but missing editorial — i.e., user re-opens
  // /autoblog/setup for a project that hasn't been enriched yet.
  useEffect(() => {
    if (step !== "review") return;
    const editorialBlank = !niche && !description && !keywords;
    if (editorialBlank && domain) void autoFillFromDomain();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  async function onDiscoverHomepage(e: React.FormEvent) {
    e.preventDefault();
    if (!homepageUrl.trim()) {
      setError("Paste your homepage URL.");
      return;
    }
    setError(null);
    setNotice(null);
    setDiscovering(true);
    const res = await discoverFromHomepage(homepageUrl);
    setDiscovering(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setDomain(res.urls.domain);
    setBlogRoot(res.urls.blogUrl ?? "");
    setFeedUrl(res.urls.feedUrl ?? "");
    setSitemap(res.urls.sitemapUrl ?? "");
    setStep("confirm");
  }

  async function onConfirmUrls(e: React.FormEvent) {
    e.preventDefault();
    if (!blogRoot.trim() || !sitemap.trim()) {
      setError("Blog URL and sitemap URL are both required.");
      return;
    }
    // Move to review — the useEffect watching `step` then triggers
    // autoFillFromDomain (sitemap detect → model enrichment →
    // DataForSEO traffic lookup) and the spinner becomes visible.
    setStep("review");
  }

  function applyProfile(p: {
    niche: string;
    targetAudiences: string[];
    description: string;
    seedKeywords: string[];
    keywords: string[];
    seoTitle: string;
    seoDescription: string;
    tone: string;
    competitors: string[];
  }) {
    setNiche(p.niche);
    setAudiences(p.targetAudiences.join(", "));
    setDescription(p.description);
    // Preserve gate: when on, the user's hand-curated seeds and the
    // long-tail list both survive Refetch. Niche/audiences/description
    // still refresh.
    if (!preserveKeywords) {
      setSeedKeywords(p.seedKeywords.join(", "));
      setKeywords(p.keywords.join("\n"));
    }
    setSeoTitle(p.seoTitle);
    setSeoDescription(p.seoDescription);
    setTone(p.tone);
    setCompetitors(p.competitors.join(", "));
  }

  // Re-run only the DataForSEO long-tail expansion against the
  // currently-typed seed_keywords. Lets the user iterate on seeds
  // without re-triggering the model enrichment that would
  // otherwise stomp niche, description, and the seed list itself.
  async function refetchLongTailFromSeeds() {
    if (preserveKeywords) {
      setWarning(
        "Preserve keywords is on — uncheck the box to overwrite the long-tail list.",
      );
      return;
    }
    const seeds = seedKeywords
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (seeds.length === 0) {
      setError("Add at least one seed keyword first.");
      return;
    }
    setError(null);
    setWarning(null);
    setNotice(null);
    setSuggesting(true);
    const traffic = await suggestLongTailKeywords(seeds);
    setSuggesting(false);
    if (!traffic.ok) {
      setError(traffic.error);
      return;
    }
    if (traffic.suggestions.length === 0) {
      setWarning("No long-tail keywords met the traffic threshold for these seeds.");
      return;
    }
    setKeywords(
      traffic.suggestions.map((s) => `${s.keyword},${s.searchVolume}`).join("\n"),
    );
    setNotice(
      `Refetched ${traffic.suggestions.length} long-tail keyword(s) — ${traffic.tier}.`,
    );
  }

  // Cross-build: seed × modifier → "seed modifier" long-tail rows.
  // Pure client-side, no DFS call. Volume column is left blank since
  // these are hand-built phrases; the scheduler treats blank as 0 and
  // simply rotates through them in insertion order.
  function buildKeywordsFromSeedsAndModifiers() {
    const seeds = seedKeywords
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const mods = modifiers
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    if (seeds.length === 0) {
      setError("Add at least one seed keyword first.");
      return;
    }
    if (mods.length === 0) {
      setError("Add at least one modifier first.");
      return;
    }

    const rows: string[] = [];
    const seen = new Set<string>();
    for (const seed of seeds) {
      for (const mod of mods) {
        const phrase = `${seed} ${mod}`.replace(/\s+/g, " ").trim();
        if (phrase && !seen.has(phrase)) {
          seen.add(phrase);
          // No volume — leave the comma-suffix off so parseKeywordRows
          // stores the bare phrase. We can add a 0 if downstream needs
          // one, but coinpayportal's scheduler doesn't require it.
          rows.push(phrase);
        }
      }
    }

    setError(null);
    setWarning(null);
    setKeywords(rows.join("\n"));
    setPreserveKeywords(true);
    setNotice(
      `Built ${rows.length} keyword(s) from ${seeds.length} seed(s) × ${mods.length} modifier(s). Preserve keywords turned on — Refetch will leave this list alone.`,
    );
  }

  // Each line is a CSV row "<keyword>,<volume>". For seed-building and
  // dedupe we only care about the keyword half (everything before the
  // first comma).
  function keywordsAsArray(): string[] {
    return keywords
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  const [scheduling, setScheduling] = useState(false);
  const [publishing, setPublishing] = useState(false);

  async function onGenerateSchedule() {
    if (keywordsAsArray().length === 0) {
      setError("No keywords to schedule. Refetch first.");
      return;
    }
    setError(null);
    setWarning(null);
    setNotice(null);
    setScheduling(true);
    const res = await generateSchedule({
      projectId,
      keywords,
      days: 30,
    });
    setScheduling(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setQueuedCount(res.scheduled);
    setNotice(`Scheduled ${res.scheduled} posts over the next 30 days.`);
  }

  async function onPreviewNow() {
    setError(null);
    setWarning(null);
    setNotice(null);
    setPublishing(true);
    const res = await previewNow({ projectId });
    setPublishing(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setNotice(
      "Preview generation enqueued. Open the Autoblog tab in ~30s — articles in 'ready' state are previews waiting on Publish.",
    );
  }

  async function runOperation(
    nextOperation: Operation,
    path: string,
    successMsg: string,
  ): Promise<boolean> {
    setError(null);
    setWarning(null);
    setNotice(null);
    setOperation(nextOperation);
    const res = await callOperation(path);
    setOperation(null);
    if (!res.ok) {
      setError(res.error ?? "Request failed.");
      return false;
    }
    setNotice(res.message ?? successMsg);
    if (nextOperation === "keywords" || nextOperation === "regenerate") {
      setKeywordFailure(null);
    }
    window.setTimeout(() => router.refresh(), 5000);
    return true;
  }

  async function regenerateQueue() {
    const total = queuedCount + failedCount;
    const summary =
      total > 0
        ? `Delete ${queuedCount} queued + ${failedCount} failed keyword${total === 1 ? "" : "s"} and spend ~$0.22 on fresh research?`
        : "Re-run keyword research with your current niche/audiences?";
    if (
      !window.confirm(
        `${summary}\n\nPublished keywords stay deduped so we don't regenerate the same articles.`,
      )
    ) {
      return;
    }
    const ok = await runOperation(
      "regenerate",
      `/api/lx/keywords/regenerate?projectId=${encodeURIComponent(projectId)}`,
      "Queue cleared — fresh research queued.",
    );
    if (ok) {
      setQueuedCount(0);
      setFailedCount(0);
      setKeywordFailure(null);
    }
  }

  function toggleDay(n: number) {
    setDays((d) => (d.includes(n) ? d.filter((x) => x !== n) : [...d, n].sort()));
  }

  const statusText =
    error ??
    warning ??
    notice ??
    (operation === "sitemap"
      ? "Sitemap crawl is being queued..."
      : operation === "keywords"
        ? "Keyword research is being queued..."
        : operation === "regenerate"
          ? "Clearing the old queue and starting fresh research..."
          : scheduling
            ? "Building the 30-day keyword schedule..."
            : publishing
              ? "Article preview generation is being queued..."
              : pending
                ? "Saving autoblog settings..."
                : autoFilling
                  ? "Refreshing the editorial profile and keyword list..."
                  : suggesting
                    ? "Refreshing long-tail keywords..."
                    : "Idle.");
  const statusTone = error
    ? "text-[var(--color-fail)]"
    : warning
      ? "text-amber-500 dark:text-amber-400"
      : notice
        ? "text-[var(--color-pass)]"
        : "text-[var(--color-muted)]";

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const res = await createOrUpdateSite({
        siteId: initial?.id,
        projectId,
        domain,
        blogRootUrl: blogRoot,
        sitemapUrl: sitemap,
        niche,
        targetAudiences: audiences,
        description,
        seedKeywords,
        modifiers,
        preserveKeywords,
        keywords,
        seoTitle,
        seoDescription,
        tone,
        bannerStyle,
        competitors,
        webhookUrl,
        webhookSecret,
        dailyArticleCount: dailyCount,
        publishDays: days,
        publishHour,
        internalLinksPerArticle: internalLinks,
        backlinksEnabled,
        externalLinksPerArticle: externalLinks,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setNotice("Settings saved.");
      if (!initial) {
        router.push(`/dashboard/projects/${projectId}/autoblog`);
      } else {
        router.refresh();
      }
    });
  }

  if (step === "discover") {
    return (
      <form onSubmit={onDiscoverHomepage} className="mt-6 space-y-4">
        <div className="card p-5">
          <h2 className="text-lg font-semibold">What's your site?</h2>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            Paste your homepage URL. We'll try to find your blog, RSS feed,
            and sitemap. You'll get a chance to fix anything we miss.
          </p>
          <div className="mt-4">
            <input
              className="input"
              type="text"
              placeholder="example.com"
              required
              value={homepageUrl}
              onChange={(e) => setHomepageUrl(e.target.value)}
              autoFocus
            />
          </div>
          {error && (
            <p className="mt-3 text-sm text-[var(--color-fail)]">{error}</p>
          )}
          <div className="mt-4">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={discovering}
            >
              {discovering ? "Detecting…" : "Detect"}
            </button>
          </div>
        </div>
      </form>
    );
  }

  if (step === "confirm") {
    const missing: string[] = [];
    if (!blogRoot) missing.push("blog URL");
    if (!feedUrl) missing.push("RSS feed (optional)");
    if (!sitemap) missing.push("sitemap URL");
    return (
      <form onSubmit={onConfirmUrls} className="mt-6 space-y-4">
        <div className="card p-5">
          <h2 className="text-lg font-semibold">Confirm what we found</h2>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            {missing.length > 0
              ? `We couldn't auto-find: ${missing.join(", ")}. Fill in whatever's missing — we'll re-scrape these URLs to write your editorial profile.`
              : "Looks like we found everything. Review and continue."}
          </p>

          <div className="mt-4 space-y-3">
            <div>
              <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
                Blog URL{" "}
                {blogRoot ? (
                  <span className="text-[var(--color-pass)]">· auto-detected</span>
                ) : (
                  <span className="text-[var(--color-warn)]">· needed</span>
                )}
              </label>
              <input
                className="input mt-1"
                type="url"
                placeholder="https://example.com/blog"
                required
                value={blogRoot}
                onChange={(e) => setBlogRoot(e.target.value)}
              />
            </div>

            <div>
              <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
                RSS / Atom feed (optional){" "}
                {feedUrl && (
                  <span className="text-[var(--color-pass)]">· auto-detected</span>
                )}
              </label>
              <input
                className="input mt-1"
                type="url"
                placeholder="https://example.com/feed"
                value={feedUrl}
                onChange={(e) => setFeedUrl(e.target.value)}
              />
              <p className="mt-1 text-xs text-[var(--color-muted)]">
                If your blog has a feed, we'll use the recent post titles to
                write a sharper editorial profile. Skip if you don't have one.
              </p>
            </div>

            <div>
              <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
                Sitemap URL{" "}
                {sitemap ? (
                  <span className="text-[var(--color-pass)]">· auto-detected</span>
                ) : (
                  <span className="text-[var(--color-warn)]">· needed</span>
                )}
              </label>
              <input
                className="input mt-1"
                type="url"
                placeholder="https://example.com/sitemap.xml"
                required
                value={sitemap}
                onChange={(e) => setSitemap(e.target.value)}
              />
            </div>
          </div>

          {error && (
            <p className="mt-3 text-sm text-[var(--color-fail)]">{error}</p>
          )}
          <div className="mt-4 flex gap-2">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={enriching}
            >
              {enriching ? "Reading your blog…" : "Continue"}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setError(null);
                setStep("discover");
              }}
            >
              Back
            </button>
          </div>
        </div>
      </form>
    );
  }

  return (
    <form onSubmit={submit} className="mt-6 space-y-6">
      {/* Site basics */}
      <section className="space-y-3">
        <h2 className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          Site
        </h2>
        <div>
          <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
            Domain
          </label>
          <div className="mt-1 flex gap-2">
            <input
              className="input flex-1"
              type="text"
              placeholder="example.com"
              required
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              onBlur={onDomainBlur}
              autoFocus
            />
            <button
              type="button"
              className="btn"
              onClick={() => void autoFillFromDomain(true)}
              disabled={!domain || autoFilling}
              title="Re-run sitemap detect + AI enrichment + DataForSEO traffic lookup"
            >
              {autoFilling ? "Fetching…" : "Refetch"}
            </button>
          </div>
        </div>
        <div>
          <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
            Blog root URL
          </label>
          <input
            className="input mt-1"
            type="url"
            placeholder="https://example.com/blog"
            required
            value={blogRoot}
            onChange={(e) => setBlogRoot(e.target.value)}
          />
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            Where your posts live publicly. Used to construct article URLs and (later) verify backlinks.
          </p>
        </div>
        <div>
          <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
            Sitemap URL
          </label>
          <input
            className="input mt-1"
            type="url"
            placeholder="https://example.com/sitemap.xml"
            required
            value={sitemap}
            onChange={(e) => setSitemap(e.target.value)}
          />
        </div>
      </section>

      {/* Editorial profile */}
      <section className="space-y-3">
        <h2 className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          Editorial profile
        </h2>
        <div>
          <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
            Niche
          </label>
          <input
            className="input mt-1"
            type="text"
            placeholder="cybersecurity, B2B SaaS, etc."
            value={niche}
            onChange={(e) => setNiche(e.target.value)}
          />
        </div>
        <div>
          <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
            Target audiences (comma-separated, up to 6)
          </label>
          <input
            className="input mt-1"
            type="text"
            placeholder="security engineers, CISOs, devops leads"
            value={audiences}
            onChange={(e) => setAudiences(e.target.value)}
          />
        </div>
        <div>
          <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
            Description
          </label>
          <textarea
            className="input mt-1 min-h-[6rem]"
            placeholder="One paragraph: what the site does, who it's for, what tone to use."
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div>
          <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
            Seed keywords (comma-separated, 1-3 word head terms)
          </label>
          <div className="mt-1 flex gap-2">
            <input
              className="input flex-1 font-mono text-sm"
              type="text"
              placeholder="web security, cyber security, penetration testing"
              value={seedKeywords}
              onChange={(e) => setSeedKeywords(e.target.value)}
            />
            <button
              type="button"
              className="btn"
              onClick={() => void refetchLongTailFromSeeds()}
              disabled={suggesting || !seedKeywords.trim()}
              title="Re-run DataForSEO long-tail expansion using the current seed keywords (does not overwrite seeds, niche, or description)"
            >
              {suggesting ? "Refetching…" : "Refetch keywords"}
            </button>
          </div>
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            Broad terms DataForSEO expands into long-tail. Auto-filled by{" "}
            <em>Refetch</em>; edit freely. Hit <em>Refetch keywords</em> to
            regenerate the long-tail list below from your current seeds without
            touching anything else.
          </p>
        </div>

        <div>
          <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
            Modifiers (comma-separated tail terms)
          </label>
          <div className="mt-1 flex gap-2">
            <input
              className="input flex-1 font-mono text-sm"
              type="text"
              placeholder="payments, transactions, merchant account, payment gateway, payment processing"
              value={modifiers}
              onChange={(e) => setModifiers(e.target.value)}
            />
            <button
              type="button"
              className="btn"
              onClick={buildKeywordsFromSeedsAndModifiers}
              disabled={!seedKeywords.trim() || !modifiers.trim()}
              title="Cross every seed with every modifier to build the long-tail list locally (no DataForSEO call). Turns on Preserve keywords."
            >
              Build from seeds × modifiers
            </button>
          </div>
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            Crossed with seeds locally — e.g. <code>peptide payments</code>,{" "}
            <code>peptide merchant account</code>, …. Skips DataForSEO. Building
            turns on <em>Preserve keywords</em> so Refetch won&apos;t overwrite
            the list.
          </p>
        </div>

        <div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={preserveKeywords}
              onChange={(e) => setPreserveKeywords(e.target.checked)}
            />
            <span>
              <span className="font-medium">Preserve keywords</span> — Refetch
              flows skip the seed list and the long-tail list (still refresh
              niche, audiences, description).
            </span>
          </label>
        </div>

        <div>
          <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
            Keywords — one CSV row per line: <code>keyword,monthly_volume</code>
          </label>
          <textarea
            className="input mt-1 min-h-[8rem] font-mono text-sm"
            placeholder={
              "soc2 compliance for startups,1200\nzero trust network access,2400\nkubernetes runtime security,720"
            }
            value={keywords}
            onChange={(e) => setKeywords(e.target.value)}
          />
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            {keywordsAsArray().length} keyword(s). Each row is{" "}
            <code>keyword,monthly_volume</code>. Auto-filled by{" "}
            <em>Refetch</em> — zero-traffic phrases are dropped.
          </p>
        </div>
        <div>
          <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
            Tone (comma-separated descriptors)
          </label>
          <input
            className="input mt-1"
            type="text"
            placeholder="technical, irreverent, no-fluff"
            value={tone}
            onChange={(e) => setTone(e.target.value)}
          />
        </div>
        <div>
          <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
            Banner image style
          </label>
          <select
            className="input mt-1"
            value={bannerStyle}
            onChange={(e) => setBannerStyle(e.target.value)}
          >
            {BANNER_STYLE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            {BANNER_STYLE_OPTIONS.find((o) => o.value === bannerStyle)?.hint}
            {" "}— every banner depicts the post's actual topic in this style.
          </p>
        </div>
        <div>
          <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
            SEO title (50–60 chars)
          </label>
          <input
            className="input mt-1"
            type="text"
            maxLength={70}
            placeholder="Acme — security tooling for engineering teams"
            value={seoTitle}
            onChange={(e) => setSeoTitle(e.target.value)}
          />
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            {seoTitle.length} / 60
          </p>
        </div>
        <div>
          <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
            SEO description (140–160 chars)
          </label>
          <textarea
            className="input mt-1 min-h-[4rem]"
            maxLength={160}
            placeholder="One or two sentences that show up in search results. Active voice, soft CTA."
            value={seoDescription}
            onChange={(e) => setSeoDescription(e.target.value)}
          />
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            {seoDescription.length} / 160
          </p>
        </div>
        <div>
          <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
            Competitors (comma-separated, up to 5)
          </label>
          <input
            className="input mt-1"
            type="text"
            placeholder="stripe.com, segment.com, datadog.com"
            value={competitors}
            onChange={(e) => setCompetitors(e.target.value)}
          />
        </div>
      </section>

      {/* Publishing schedule */}
      <section className="space-y-3">
        <h2 className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          Publishing schedule
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
              Articles / day
            </label>
            <select
              className="input mt-1"
              value={dailyCount}
              onChange={(e) => setDailyCount(parseInt(e.target.value, 10))}
            >
              {[1, 2, 3].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
              Publish hour (UTC)
            </label>
            <select
              className="input mt-1"
              value={publishHour}
              onChange={(e) => setPublishHour(parseInt(e.target.value, 10))}
            >
              {Array.from({ length: 24 }, (_, i) => i).map((h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, "0")}:00
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
              Internal links / article
            </label>
            <select
              className="input mt-1"
              value={internalLinks}
              onChange={(e) => setInternalLinks(parseInt(e.target.value, 10))}
            >
              {[0, 1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
            Publishing days
          </label>
          <div className="mt-1 flex flex-wrap gap-2">
            {DAY_LABELS.map((d) => (
              <button
                key={d.n}
                type="button"
                onClick={() => toggleDay(d.n)}
                className={
                  "rounded border px-3 py-1 text-sm " +
                  (days.includes(d.n)
                    ? "border-[var(--color-accent)] text-[var(--color-accent)]"
                    : "border-[var(--color-border)] text-[var(--color-muted)]")
                }
              >
                {d.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* Backlink exchange (Link Exchange phase — currently invitation-only) */}
      <section className="space-y-3">
        <h2 className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          Backlink exchange
        </h2>
        <p className="text-xs text-[var(--color-muted)]">
          When enabled, articles will include outbound links to other
          sites in the Crawlproof network whose niche matches yours.
          The network is currently invitation-only; toggling on now
          opts you in for when it opens to your niche.
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={backlinksEnabled}
            onChange={(e) => setBacklinksEnabled(e.target.checked)}
          />
          Participate in the backlink exchange
        </label>
        <div>
          <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
            Outbound exchange links / article
          </label>
          <select
            className="input mt-1"
            value={externalLinks}
            onChange={(e) => setExternalLinks(parseInt(e.target.value, 10))}
            disabled={!backlinksEnabled}
          >
            {[0, 1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            How many network links your articles will carry once the
            exchange opens. Receivers' niche + quality gates still
            decide whether your post is accepted on the other end.
          </p>
        </div>
      </section>

      {/* Webhook */}
      <section className="space-y-3">
        <h2 className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          Webhook
        </h2>
        <div>
          <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
            Webhook URL
          </label>
          <input
            className="input mt-1"
            type="url"
            placeholder="https://example.com/api/crawlproof-webhook"
            required
            value={webhookUrl}
            onChange={(e) => setWebhookUrl(e.target.value)}
          />
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            We POST a JSON body with the article. Your endpoint must reply 2xx within 10s.
            See <a className="underline" href="/docs/autoblog-webhook">webhook docs</a>.
          </p>
        </div>
        <div>
          <label className="text-sm font-medium" htmlFor="webhookSecret">
            Bearer token
          </label>
          <input
            id="webhookSecret"
            className="input mt-1 font-mono text-xs"
            type="text"
            placeholder="<secret-key>"
            required
            value={webhookSecret}
            onChange={(e) => setWebhookSecret(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            Generate this on your receiver site (the blog) and paste it here.
            We'll send it as <code>Authorization: Bearer …</code> on every
            webhook call so your endpoint can authenticate the request.
            Pasting a new value rotates it.
          </p>
        </div>
      </section>

      <section className="card p-4 text-sm">
        <h2 className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          Status
        </h2>
        <p className={`mt-3 min-h-5 ${statusTone}`} role="status" aria-live="polite">
          {statusText}
        </p>
        {initial && (
          <>
            <dl className="mt-3 grid gap-2 sm:grid-cols-2">
              <dt className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
                Queued keywords
              </dt>
              <dd>{queuedCount}</dd>
              <dt className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
                Failed keywords
              </dt>
              <dd>{failedCount}</dd>
              <dt className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
                Keyword research
              </dt>
              <dd>
                {keywordFailure ? (
                  <span className="text-[var(--color-fail)]">
                    {keywordFailure.replace(/^Keyword research failed:\s*/, "")}
                  </span>
                ) : (
                  <span className="text-[var(--color-muted)]">no recent errors</span>
                )}
              </dd>
            </dl>
            <div className="mt-4 flex flex-wrap gap-2 border-t border-[var(--color-border)] pt-4">
              <button
                type="button"
                className="btn"
                disabled={operation !== null}
                onClick={() =>
                  void runOperation(
                    "sitemap",
                    `/api/lx/sitemap/refresh?projectId=${encodeURIComponent(projectId)}`,
                    "Sitemap crawl queued.",
                  )
                }
              >
                {operation === "sitemap" ? "Crawling..." : "Refresh sitemap"}
              </button>
              <button
                type="button"
                className="btn"
                disabled={operation !== null}
                onClick={() =>
                  void runOperation(
                    "keywords",
                    `/api/lx/keywords/refresh?projectId=${encodeURIComponent(projectId)}`,
                    "Keyword research queued.",
                  )
                }
              >
                {operation === "keywords" ? "Generating..." : "Generate keywords"}
              </button>
              <button
                type="button"
                className="btn"
                disabled={operation !== null}
                onClick={() => void regenerateQueue()}
                title="Clear queued + failed keywords and re-run research with your current niche/audiences/seeds."
              >
                {operation === "regenerate" ? "Regenerating..." : "Regenerate queue"}
              </button>
            </div>
          </>
        )}
      </section>

      <div className="flex flex-wrap gap-3">
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? "Saving…" : initial ? "Save settings" : "Create Autoblog"}
        </button>
        {initial && (
          <>
            <button
              type="button"
              className="btn"
              onClick={onGenerateSchedule}
              disabled={scheduling || keywordsAsArray().length === 0}
              title="Queue up to 30 days of posts (one keyword per slot), honoring publish days"
            >
              {scheduling ? "Scheduling…" : "Generate 30-day schedule"}
            </button>
            <button
              type="button"
              className="btn"
              onClick={onPreviewNow}
              disabled={publishing}
              title="Generate one article right now without delivering — review it before publishing"
            >
              {publishing ? "Generating…" : "Preview next post"}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => router.back()}
            >
              Cancel
            </button>
          </>
        )}
      </div>
    </form>
  );
}
