"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

// Visual stages — these are NOT tied to actual worker progress (the worker
// reports only queued/running/complete), they're a plausible sequence so the
// wait feels like progress instead of a blank spinner. The poller snaps to
// "complete" the moment the real audit finishes.
const STAGES: { label: string; ms: number }[] = [
  { label: "Fetching homepage", ms: 3500 },
  { label: "Rendering with headless Chromium", ms: 9000 },
  { label: "Probing robots.txt + sitemap.xml", ms: 2500 },
  { label: "Checking AI-bot rules (GPTBot, ClaudeBot, PerplexityBot, …)", ms: 2500 },
  { label: "Probing /llms.txt and /skill.md", ms: 2000 },
  { label: "Parsing JSON-LD structured data", ms: 2500 },
  { label: "Crawling linked pages", ms: 10000 },
  { label: "Analyzing positioning clarity", ms: 3500 },
  { label: "Generating recommendations", ms: 3000 },
  { label: "Rendering Markdown report", ms: 3000 },
  { label: "Finalizing", ms: 5000 },
];

function format(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function LivePoller({ id }: { id: string }) {
  const router = useRouter();
  const [elapsedMs, setElapsedMs] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const res = await fetch(`/api/audits/${id}`, { cache: "no-store" });
        const data = await res.json();
        const status = data?.audit?.status;
        if (status === "complete") router.refresh();
        else if (status === "failed") {
          setFailed(true);
          router.refresh();
        }
      } catch {
        /* next tick will retry */
      }
    }, 2000);
    return () => clearInterval(t);
  }, [id, router]);

  useEffect(() => {
    const start = Date.now();
    const t = setInterval(() => setElapsedMs(Date.now() - start), 250);
    return () => clearInterval(t);
  }, []);

  let acc = 0;
  let stageIdx = STAGES.length - 1;
  for (let i = 0; i < STAGES.length; i++) {
    acc += STAGES[i].ms;
    if (elapsedMs < acc) {
      stageIdx = i;
      break;
    }
  }
  const totalMs = STAGES.reduce((a, b) => a + b.ms, 0);
  const pct = Math.min(98, (elapsedMs / totalMs) * 100);

  return (
    <div className="card relative overflow-hidden p-10">
      <div className="pointer-events-none absolute inset-0 opacity-30">
        <div className="scanline absolute left-0 right-0 h-px bg-gradient-to-r from-transparent via-[var(--color-accent)] to-transparent" />
      </div>

      <div className="relative flex flex-col items-center text-center">
        <div className="relative size-32">
          <div className="absolute inset-0 rounded-full border-4 border-[var(--color-border)]" />
          <div
            className="absolute inset-0 animate-spin rounded-full border-4 border-b-transparent border-l-transparent border-r-transparent border-t-[var(--color-accent)]"
            style={{ animationDuration: "1.6s" }}
          />
          <div
            className="absolute inset-3 animate-spin rounded-full border-2 border-b-transparent border-l-transparent border-t-transparent border-r-[var(--color-accent)]"
            style={{ animationDuration: "2.4s", animationDirection: "reverse" }}
          />
          <div className="absolute inset-7 animate-pulse rounded-full bg-[var(--color-accent)]/20" />
          <div className="absolute inset-0 flex items-center justify-center font-mono text-xs text-[var(--color-muted)]">
            {format(Math.floor(elapsedMs / 1000))}
          </div>
        </div>

        <h2 className="mt-6 text-xl font-bold">
          {failed ? "Audit failed" : "Auditing your site…"}
        </h2>
        <p className="mt-2 min-h-[1.5rem] text-[var(--color-muted)]">
          {failed ? "Please try again." : STAGES[stageIdx]?.label}
        </p>

        <div className="mt-4 h-1.5 w-full max-w-md overflow-hidden rounded-full bg-[var(--color-border)]">
          <div
            className="h-full bg-[var(--color-accent)] transition-[width] duration-500 ease-out"
            style={{ width: `${failed ? 100 : pct}%` }}
          />
        </div>
        <p className="mt-2 text-xs text-[var(--color-muted)]">
          Typical run: 30–90 seconds. Heavy sites can take longer.
        </p>

        <ul className="mt-8 grid w-full max-w-md gap-1.5 text-left text-sm">
          {STAGES.map((s, i) => {
            const state = i < stageIdx ? "done" : i === stageIdx ? "active" : "pending";
            return (
              <li key={s.label} className="flex items-center gap-3">
                <span
                  className={
                    state === "done"
                      ? "inline-flex size-4 items-center justify-center rounded-full bg-[var(--color-pass)] text-[10px] text-black"
                      : state === "active"
                        ? "inline-block size-4 animate-pulse rounded-full border-2 border-[var(--color-accent)]"
                        : "inline-block size-4 rounded-full border border-[var(--color-border)]"
                  }
                >
                  {state === "done" ? "✓" : ""}
                </span>
                <span
                  className={
                    state === "done"
                      ? "text-[var(--color-fg)]"
                      : state === "active"
                        ? "font-medium text-[var(--color-fg)]"
                        : "text-[var(--color-muted)]"
                  }
                >
                  {s.label}
                </span>
              </li>
            );
          })}
        </ul>
      </div>

      <style>{`
        @keyframes scan { 0% { transform: translateY(0); } 100% { transform: translateY(100%); } }
        .scanline { animation: scan 2.5s linear infinite; }
      `}</style>
    </div>
  );
}
