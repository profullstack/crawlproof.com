"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  createOrUpdateSite,
  detectSitemap,
  rotateWebhookSecret,
} from "@/app/actions/linkExchange";

type Existing = {
  id: string;
  domain: string;
  blog_root_url: string;
  sitemap_url: string;
  niche: string | null;
  target_audiences: string[];
  description: string;
  webhook_url: string | null;
  webhook_secret: string | null;
  daily_article_count: number;
  publish_days: number[];
  publish_hour: number;
  internal_links_per_article: number;
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

function WebhookSecretCard({
  secret,
  onRotate,
  rotating,
}: {
  secret: string;
  onRotate: () => void;
  rotating: boolean;
}) {
  const [copied, setCopied] = useState(false);

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API can fail under permissions/insecure-context — fall
      // back to a manual select via a hidden textarea.
      const ta = document.createElement("textarea");
      ta.value = secret;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      } finally {
        document.body.removeChild(ta);
      }
    }
  }

  return (
    <div className="card p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          Bearer secret
        </span>
        <div className="flex gap-2">
          <button type="button" className="btn text-xs" onClick={onCopy}>
            {copied ? "Copied!" : "Copy"}
          </button>
          <button
            type="button"
            className="btn text-xs"
            onClick={onRotate}
            disabled={rotating}
          >
            {rotating ? "Rotating…" : "Regenerate"}
          </button>
        </div>
      </div>
      <code className="mt-2 block break-all font-mono text-xs">{secret}</code>
      <p className="mt-2 text-xs text-[var(--color-muted)]">
        Sent as <code>Authorization: Bearer …</code>. Store it on your
        receiver and verify on every request.
      </p>
    </div>
  );
}

export function SetupForm({ initial }: { initial: Existing | null }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [detecting, setDetecting] = useState(false);
  const [rotating, startRotation] = useTransition();

  const [domain, setDomain] = useState(initial?.domain ?? "");
  const [blogRoot, setBlogRoot] = useState(initial?.blog_root_url ?? "");
  const [sitemap, setSitemap] = useState(initial?.sitemap_url ?? "");
  const [niche, setNiche] = useState(initial?.niche ?? "");
  const [audiences, setAudiences] = useState(
    (initial?.target_audiences ?? []).join(", "),
  );
  const [description, setDescription] = useState(initial?.description ?? "");
  const [webhookUrl, setWebhookUrl] = useState(initial?.webhook_url ?? "");
  const [webhookSecret, setWebhookSecret] = useState<string | null>(
    initial?.webhook_secret ?? null,
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

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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

  async function onRotate() {
    setError(null);
    startRotation(async () => {
      const res = await rotateWebhookSecret();
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setWebhookSecret(res.webhookSecret);
      setNotice("New webhook secret generated. Update your receiver.");
    });
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
        domain,
        blogRootUrl: blogRoot,
        sitemapUrl: sitemap,
        niche,
        targetAudiences: audiences,
        description,
        webhookUrl,
        dailyArticleCount: dailyCount,
        publishDays: days,
        publishHour,
        internalLinksPerArticle: internalLinks,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      if (res.webhookSecret) {
        setWebhookSecret(res.webhookSecret);
        setNotice(
          "Saved. Copy the webhook secret below — we'll show its prefix only after you leave this page.",
        );
        return;
      }
      setNotice("Settings saved.");
      router.refresh();
    });
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
        {webhookSecret && (
          <WebhookSecretCard
            secret={webhookSecret}
            onRotate={onRotate}
            rotating={rotating}
          />
        )}
      </section>

      {error && <p className="text-sm text-[var(--color-fail)]">{error}</p>}
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
