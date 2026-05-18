"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  createOrUpdateSite,
  detectSitemap,
  discoverFromHomepage,
  enrichFromUrls,
  suggestLongTailKeywords,
  type KeywordSuggestion,
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
  status: string;
};

const DAY_LABELS: Array<{ n: number; label: string }> = [
  { n: 1, label: "Mon" },
  { n: 2, label: "Tue" },
  { n: 3, label: "Wed" },
  { n: 4, label: "Thu" },
  { n: 5, label: "Fri" },
  { n: 6, label: "Sat" },
  { n: 7, label: "Sun" },
];

export function SetupForm({ initial }: { initial: Existing | null }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [detecting, setDetecting] = useState(false);

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
  const [keywords, setKeywords] = useState(
    (initial?.keywords ?? []).join("\n"),
  );
  const [seoTitle, setSeoTitle] = useState(initial?.seo_title ?? "");
  const [seoDescription, setSeoDescription] = useState(initial?.seo_description ?? "");
  const [tone, setTone] = useState(initial?.tone ?? "");
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
  const [suggestions, setSuggestions] = useState<KeywordSuggestion[]>([]);
  const [suggesting, setSuggesting] = useState(false);

  function onDomainBlur() {
    if (!domain) return;
    const host = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
    if (!blogRoot) setBlogRoot(`https://${host}/blog`);
  }

  async function onDetectSitemap() {
    if (!domain) {
      setError("Enter a domain first.");
      return;
    }
    setError(null);
    setDetecting(true);
    const res = await detectSitemap(domain);
    setDetecting(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    if (!res.sitemapUrl) {
      setError("Couldn't find a sitemap. Paste the URL manually.");
      return;
    }
    setSitemap(res.sitemapUrl);
    setNotice(`Sitemap found: ${res.sitemapUrl}`);
  }

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
    setError(null);
    setWarning(null);
    setNotice(null);
    setEnriching(true);
    const res = await enrichFromUrls({
      blogUrl: blogRoot.trim(),
      feedUrl: feedUrl.trim() || null,
      sitemapUrl: sitemap.trim() || null,
    });
    setEnriching(false);
    if (!res.ok) {
      // Soft-fail: surface a warning so the user knows enrichment didn't
      // run and they need to fill the editorial fields by hand.
      setWarning(
        `Couldn't auto-write your editorial profile (${res.error}). Fill in the niche, audiences, and description below.`,
      );
      setStep("review");
      return;
    }
    applyProfile(res.profile);
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
    setSeedKeywords(p.seedKeywords.join(", "));
    setKeywords(p.keywords.join("\n"));
    setSeoTitle(p.seoTitle);
    setSeoDescription(p.seoDescription);
    setTone(p.tone);
    setCompetitors(p.competitors.join(", "));
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

  function keywordNameFromRow(row: string): string {
    const idx = row.indexOf(",");
    return (idx === -1 ? row : row.slice(0, idx)).trim();
  }

  async function onSuggestKeywords() {
    // DFS expansion runs on BROAD head terms from seed_keywords. We
    // intentionally don't include the user's long-tail keywords as
    // seeds — they're already specific, expanding from them tends to
    // return nothing.
    const seeds = seedKeywords
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (seeds.length === 0) {
      setError(
        "Add seed keywords first (1-3 word head terms). Run Fetch metadata to auto-generate them.",
      );
      return;
    }
    setError(null);
    setWarning(null);
    setNotice(null);
    setSuggesting(true);
    const res = await suggestLongTailKeywords(seeds);
    setSuggesting(false);
    if (!res.ok) {
      setWarning(`Couldn't fetch suggestions (${res.error}).`);
      setSuggestions([]);
      return;
    }
    setSuggestions(res.suggestions);
    if (res.suggestions.length === 0) {
      setNotice("No keyword suggestions found for those seeds.");
    } else {
      setNotice(
        `${res.suggestions.length} suggestion(s) — ${res.tier}. Click to add.`,
      );
    }
  }

  function formatRow(s: KeywordSuggestion): string {
    return `${s.keyword},${s.searchVolume}`;
  }

  function addSuggestion(s: KeywordSuggestion) {
    const existing = new Set(
      keywordsAsArray().map((row) => keywordNameFromRow(row).toLowerCase()),
    );
    if (existing.has(s.keyword.toLowerCase())) return;
    const row = formatRow(s);
    setKeywords((prev) => (prev.trim() ? `${prev.trim()}\n${row}` : row));
    setSuggestions((prev) => prev.filter((x) => x.keyword !== s.keyword));
  }

  function addAllSuggestions() {
    const existing = new Set(
      keywordsAsArray().map((row) => keywordNameFromRow(row).toLowerCase()),
    );
    const fresh = suggestions
      .filter((s) => !existing.has(s.keyword.toLowerCase()))
      .map(formatRow);
    if (fresh.length === 0) return;
    setKeywords((prev) =>
      prev.trim() ? `${prev.trim()}\n${fresh.join("\n")}` : fresh.join("\n"),
    );
    setSuggestions([]);
  }

  async function onFetchMetadata() {
    if (!blogRoot.trim()) {
      setError("Set a blog URL first.");
      return;
    }
    setError(null);
    setWarning(null);
    setNotice(null);
    setEnriching(true);
    const res = await enrichFromUrls({
      blogUrl: blogRoot.trim(),
      feedUrl: feedUrl.trim() || null,
      sitemapUrl: sitemap.trim() || null,
    });
    setEnriching(false);
    if (!res.ok) {
      setWarning(`Couldn't fetch metadata (${res.error}).`);
      return;
    }
    applyProfile(res.profile);
    setNotice("Metadata fetched.");
  }

  function toggleDay(n: number) {
    setDays((d) => (d.includes(n) ? d.filter((x) => x !== n) : [...d, n].sort()));
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const res = await createOrUpdateSite({
        siteId: initial?.id,
        domain,
        blogRootUrl: blogRoot,
        sitemapUrl: sitemap,
        niche,
        targetAudiences: audiences,
        description,
        seedKeywords,
        keywords,
        seoTitle,
        seoDescription,
        tone,
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
      router.refresh();
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
          <input
            className="input mt-1"
            type="text"
            placeholder="example.com"
            required
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            onBlur={onDomainBlur}
            autoFocus
          />
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
          <div className="mt-1 flex gap-2">
            <input
              className="input"
              type="url"
              placeholder="https://example.com/sitemap.xml"
              required
              value={sitemap}
              onChange={(e) => setSitemap(e.target.value)}
            />
            <button
              type="button"
              className="btn"
              onClick={onDetectSitemap}
              disabled={detecting || !domain}
            >
              {detecting ? "Detecting…" : "Detect"}
            </button>
          </div>
        </div>
      </section>

      {/* Editorial profile */}
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
            Editorial profile
          </h2>
          <button
            type="button"
            className="btn text-xs"
            onClick={onFetchMetadata}
            disabled={enriching}
            title="Re-run AI enrichment on the blog URL above"
          >
            {enriching ? "Fetching…" : "Fetch metadata"}
          </button>
        </div>
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
          <input
            className="input mt-1 font-mono text-sm"
            type="text"
            placeholder="web security, cyber security, penetration testing"
            value={seedKeywords}
            onChange={(e) => setSeedKeywords(e.target.value)}
          />
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            Broad terms DataForSEO expands into long-tail. Auto-filled by
            Fetch metadata; edit freely.
          </p>
        </div>
        <div>
          <div className="flex items-center justify-between gap-2">
            <label className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
              Keywords — one CSV row per line: <code>keyword,monthly_volume</code>
            </label>
            <button
              type="button"
              className="btn text-xs"
              onClick={onSuggestKeywords}
              disabled={suggesting}
              title="Expand seed keywords into long-tail with traffic data via DataForSEO"
            >
              {suggesting ? "Searching…" : "Suggest from seeds"}
            </button>
          </div>
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
            <code>keyword,monthly_volume</code>. Aim for 3+ word phrases at
            300+/mo so each post can plausibly hit 300+ visits.
          </p>

          {suggestions.length > 0 && (
            <div className="mt-3 rounded border border-[var(--color-border)] p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
                  Suggestions
                </span>
                <button
                  type="button"
                  className="text-xs underline"
                  onClick={addAllSuggestions}
                >
                  Add all
                </button>
              </div>
              <ul className="space-y-1">
                {suggestions.map((s) => (
                  <li
                    key={s.keyword}
                    className="flex items-center justify-between gap-2 text-sm"
                  >
                    <button
                      type="button"
                      onClick={() => addSuggestion(s)}
                      className="flex-1 text-left hover:underline"
                      title={`Add as "${s.keyword},${s.searchVolume}"`}
                    >
                      <span className="font-mono">
                        + {s.keyword},{s.searchVolume}
                      </span>
                    </button>
                    <span className="shrink-0 text-xs text-[var(--color-muted)] tabular-nums">
                      {s.cpcUsd != null && s.cpcUsd > 0 && (
                        <>${s.cpcUsd.toFixed(2)} CPC</>
                      )}
                      {s.competition && <> · {s.competition.toLowerCase()}</>}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
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
            placeholder="cp_lx_…"
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

      {error && <p className="text-sm text-[var(--color-fail)]">{error}</p>}
      {warning && (
        <p className="text-sm text-amber-500 dark:text-amber-400">
          ⚠ {warning}
        </p>
      )}
      {notice && (
        <p className="text-sm text-[var(--color-pass)]">{notice}</p>
      )}

      <div className="flex gap-3">
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? "Saving…" : initial ? "Save settings" : "Create Autoblog"}
        </button>
        {initial && (
          <button
            type="button"
            className="btn"
            onClick={() => router.push("/autoblog")}
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
