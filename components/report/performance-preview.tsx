import Link from "next/link";
import { PerformanceCharts } from "./performance-charts";

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

      <PerformanceCharts
        overlayTitle={copy.overlayTitle}
        overlayBody={copy.overlayBody}
      />
    </div>
  );
}
