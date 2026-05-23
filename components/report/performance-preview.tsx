"use client";

import dynamic from "next/dynamic";
import Link from "next/link";

// next/dynamic with ssr:false keeps recharts (and its d3 deps) out of the
// server module graph. The homepage and report pages both render this, so
// without this gate every Node process carries recharts in resident memory
// even when nobody's looking at a chart.
const ScoreTrend = dynamic(
  () => import("@/components/charts/score-trend").then((m) => m.ScoreTrend),
  { ssr: false, loading: () => <div className="card h-64 min-h-64 min-w-0" /> },
);
const StatusPie = dynamic(
  () => import("@/components/charts/status-pie").then((m) => m.StatusPie),
  { ssr: false, loading: () => <div className="card h-64 min-h-64 min-w-0" /> },
);
const SectionBar = dynamic(
  () => import("@/components/charts/section-bar").then((m) => m.SectionBar),
  { ssr: false, loading: () => <div className="card h-72 min-h-72 min-w-0" /> },
);
const PriorityBar = dynamic(
  () => import("@/components/charts/priority-bar").then((m) => m.PriorityBar),
  { ssr: false, loading: () => <div className="card h-72 min-h-72 min-w-0" /> },
);

// Sample data — illustrative only. Picked so the chart shows an obvious
// upward trend, varied bar heights, and a non-trivial pie split. The 4
// chart components are the SAME ones used on the signed-in /projects/[id]
// dashboard, so the preview is faithful to the real product.
const SAMPLE_TREND = [
  { date: "2026-03-08T12:00:00Z", score: 48 },
  { date: "2026-03-15T12:00:00Z", score: 54 },
  { date: "2026-03-22T12:00:00Z", score: 61 },
  { date: "2026-03-29T12:00:00Z", score: 65 },
  { date: "2026-04-05T12:00:00Z", score: 70 },
  { date: "2026-04-12T12:00:00Z", score: 73 },
  { date: "2026-04-19T12:00:00Z", score: 81 },
  { date: "2026-04-26T12:00:00Z", score: 84 },
];

const SAMPLE_STATUS = { pass: 38, warn: 14, fail: 3, unknown: 1 };

const SAMPLE_SECTIONS = [
  { section: "Crawl Summary", pass: 1, warn: 0, fail: 0 },
  { section: "Data Found", pass: 9, warn: 2, fail: 1 },
  { section: "Homepage Audit", pass: 7, warn: 1, fail: 0 },
  { section: "Schema / Structured Data", pass: 4, warn: 2, fail: 0 },
  { section: "robots.txt & sitemap.xml", pass: 5, warn: 0, fail: 0 },
  { section: "LLM / AI Crawler Access", pass: 7, warn: 2, fail: 1 },
  { section: "Positioning Clarity", pass: 5, warn: 2, fail: 0 },
];

const SAMPLE_PRIORITY = { p1: 0, p2: 2, p3: 6, p4: 5, p5: 4 };

type Variant = "report" | "home";

const COPY: Record<Variant, {
  topTitle: string;
  topBody: string;
  topCta: string;
  overlayTitle: string;
  overlayBody: string;
}> = {
  report: {
    topTitle: "Track this site week over week",
    topBody:
      "Save it as a project, run scheduled re-audits, and watch your AEO score climb with the four charts below. Sample data shown.",
    topCta: "Start tracking →",
    overlayTitle: "Your charts, not these.",
    overlayBody:
      "Sign up free, add this URL as a project, and we'll rebuild the dashboard with your own scan history.",
  },
  home: {
    topTitle: "Track any site week over week",
    topBody:
      "Sign up, save a URL as a project, and watch your AEO score climb with the four charts below. Sample data shown — your dashboard updates with every re-audit.",
    topCta: "Sign up free →",
    overlayTitle: "Your dashboard, not this demo.",
    overlayBody:
      "Sign up free, add a URL as a project, and we'll build the dashboard out of your own scan history.",
  },
};

export function PerformancePreview({ variant = "report" }: { variant?: Variant } = {}) {
  const copy = COPY[variant];
  return (
    <div className="space-y-6">
      <div className="card flex flex-wrap items-center justify-between gap-3 p-5">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wider text-[var(--color-accent)]">
            Premium feature
          </div>
          <h3 className="mt-1 text-lg font-bold">{copy.topTitle}</h3>
          <p className="mt-1 text-sm text-[var(--color-muted)]">{copy.topBody}</p>
        </div>
        <Link href="/signup" className="btn btn-primary">
          {copy.topCta}
        </Link>
      </div>

      <div className="relative">
        <div
          aria-hidden
          className="pointer-events-none select-none"
        >
          <div className="grid gap-4 lg:grid-cols-2">
            <ScoreTrend data={SAMPLE_TREND} />
            <StatusPie counts={SAMPLE_STATUS} />
            <SectionBar rows={SAMPLE_SECTIONS} />
            <PriorityBar counts={SAMPLE_PRIORITY} />
          </div>
        </div>

        {/* Bottom-fade CTA so the charts are visible up top but it's clear
            this is gated behind sign-up. */}
        <div className="pointer-events-none absolute inset-0 flex items-end justify-center bg-gradient-to-b from-[var(--color-bg)]/0 via-[var(--color-bg)]/40 to-[var(--color-bg)]">
          <div className="pointer-events-auto card mb-6 max-w-md p-5 text-center shadow-lg">
            <span className="badge badge-pass">Premium</span>
            <h4 className="mt-2 text-base font-bold">{copy.overlayTitle}</h4>
            <p className="mt-1 text-sm text-[var(--color-muted)]">{copy.overlayBody}</p>
            <Link href="/signup" className="btn btn-primary mt-3 w-full">
              Sign up free
            </Link>
            <p className="mt-2 text-xs text-[var(--color-muted)]">
              3 free AI credits on signup · free rule-based scans up to the daily limit.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
