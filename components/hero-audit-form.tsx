"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { startAuditFromForm } from "@/app/actions/runAudit";

// Datafa.st injects `window.datafast` once its script.js loads. Calls
// before then are dropped silently — that's the right behavior here:
// we don't want analytics to ever block or break a real conversion.
declare global {
  interface Window {
    datafast?: (
      eventName: string,
      customData?: Record<string, string>,
      callback?: (r: { status: number }) => void,
    ) => void;
  }
}

type HeroScan = "rule" | "slop";

// Only the two free, self-hosted engines are offered anonymously — kept in
// sync with ANON_ENGINES in app/actions/runAudit.ts.
const SCAN_OPTIONS: Array<{ id: HeroScan; label: string; blurb: string }> = [
  {
    id: "rule",
    label: "AEO audit",
    blurb: "How AI crawlers and answer engines see your site, with fixes.",
  },
  {
    id: "slop",
    label: "Slop Score",
    blurb: "Sweeps up to 50 pages for careless content, code, and design.",
  },
];

export function HeroAuditForm({ defaultScan = "rule" }: { defaultScan?: HeroScan }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [url, setUrl] = useState("");
  const [scan, setScan] = useState<HeroScan>(defaultScan);
  const [listPublic, setListPublic] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [urlError, setUrlError] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setUrlError(null);
    if (!url.trim()) {
      setUrlError("Website URL is required.");
      return;
    }
    // Fire as soon as the user commits to submit (before the action).
    // This is the denominator for the conversion funnel — pageview →
    // attempt → success.
    window.datafast?.("audit_submit_attempted");
    startTransition(async () => {
      // URL-first: the report is generated and shown on-page for free.
      // Email / phone / monthly-sales are collected AFTER the report
      // (on /r/<token>) only if the user wants the PDF emailed.
      const res = await startAuditFromForm({ url, listPublic, engines: [scan] });
      if (!res.ok) {
        setError(res.error ?? "Could not start audit.");
        // Slugify the error message so we don't blow past Datafa.st's
        // 255-char value limit + keep distinct error buckets tidy.
        const reason = (res.error ?? "unknown")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_+|_+$/g, "")
          .slice(0, 64);
        window.datafast?.("audit_submit_failed", { reason });
        return;
      }
      window.datafast?.("audit_submitted", {
        listed_public: listPublic ? "yes" : "no",
        scan,
      });
      router.push(`/r/${res.token}`);
    });
  }

  return (
    <form onSubmit={submit} noValidate className="card flex flex-col gap-3 p-4 text-left">
      <div>
        <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-[var(--color-muted)]">
          Scan type
        </span>
        <div className="flex flex-col gap-2 sm:flex-row" role="radiogroup" aria-label="Scan type">
          {SCAN_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              role="radio"
              aria-checked={scan === opt.id}
              onClick={() => setScan(opt.id)}
              className="flex-1 rounded-lg border p-3 text-left transition-colors"
              style={{
                borderColor: scan === opt.id ? "var(--color-accent)" : "var(--color-border)",
                background: scan === opt.id ? "color-mix(in oklab, var(--color-accent) 8%, transparent)" : "transparent",
              }}
            >
              <span className="block text-sm font-semibold">{opt.label}</span>
              <span className="mt-0.5 block text-xs leading-snug text-[var(--color-muted)]">
                {opt.blurb}
              </span>
            </button>
          ))}
        </div>
      </div>
      <Field label="Website URL" error={urlError}>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            type="url"
            inputMode="url"
            placeholder="https://your-site.com"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              if (urlError) setUrlError(null);
            }}
            className="input flex-1"
            autoFocus
            aria-invalid={!!urlError}
          />
          <button
            type="submit"
            className="btn btn-primary whitespace-nowrap"
            disabled={pending}
          >
            {pending ? "Starting…" : scan === "slop" ? "Get free Slop Score" : "Run free audit"}
          </button>
        </div>
      </Field>
      <p className="text-xs leading-relaxed text-[var(--color-muted)]">
        No email, no signup, no card. The report opens on-page in seconds — you
        can email yourself a PDF copy from the report once it&apos;s ready.{" "}
        {/* Only two of the six free scanners can run anonymously, so the other
            four were invisible from here — real, free, and reachable by nobody.
            A link rather than four more radio buttons: the rest genuinely
            require an account, and offering them in this selector would mean
            submitting a form that cannot succeed. */}
        <Link href="/tools" className="underline">
          All free tools
        </Link>
        .
      </p>
      <div className="border-t border-[var(--color-border)] pt-3">
        <label className="flex items-start gap-2 text-xs text-[var(--color-muted)]">
          <input
            type="checkbox"
            checked={listPublic}
            onChange={(e) => setListPublic(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            List this scan publicly on Recent scans.
          </span>
        </label>
        <p className="mt-2 text-xs leading-relaxed text-[var(--color-muted)]">
          Three visibility levels:{" "}
          <strong className="font-semibold text-[var(--color-text)]">Public</strong>{" "}
          (checked above — shown on Recent scans and indexable),{" "}
          <strong className="font-semibold text-[var(--color-text)]">Unlisted</strong>{" "}
          (default — reachable only by its report link, never listed), and{" "}
          <strong className="font-semibold text-[var(--color-text)]">Private</strong>{" "}
          (sign up and save the URL as a project to keep scans in private
          history). Common tracking parameters are stripped before the URL is
          saved.
        </p>
      </div>
      {error && <p className="text-sm text-[var(--color-fail)]">{error}</p>}
    </form>
  );
}

function Field({
  label,
  helper,
  error,
  children,
}: {
  label: string;
  helper?: string;
  error?: string | null;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-[var(--color-muted)]">
        {label}
      </span>
      {children}
      {helper && !error && (
        <span className="mt-1 block text-xs leading-relaxed text-[var(--color-muted)]">
          {helper}
        </span>
      )}
      {error && (
        <span className="mt-1 block text-xs leading-relaxed text-[var(--color-fail)]">
          {error}
        </span>
      )}
    </label>
  );
}
