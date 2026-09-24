"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { videoRenderStatus } from "@/app/actions/ads";

type Status = Awaited<ReturnType<typeof videoRenderStatus>>;
type Ready = Extract<Status, { ok: true }>;

/**
 * Progress and download for a campaign's five-second pre-roll.
 *
 * Polls while the render is in flight and stops the moment it settles — a
 * finished render never changes again, so a timer that keeps running is just a
 * request every few seconds for a row that will not move. The interval is
 * deliberately unhurried: an encode takes tens of seconds, and polling faster
 * would only make the queue look busier than it is.
 */
export function VideoRenderCard({ jobId }: { jobId: string | null }) {
  const [status, setStatus] = useState<Ready | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const settled = status?.state === "ready" || status?.state === "failed";

  const poll = useCallback(async () => {
    if (!jobId) return;
    const res = await videoRenderStatus({ jobId });
    if (res.ok) {
      setStatus(res);
      setError(null);
    } else {
      setError(res.error);
    }
  }, [jobId]);

  useEffect(() => {
    if (!jobId || settled) return;
    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      await poll();
      if (!cancelled) timer.current = setTimeout(tick, 5000);
    };
    void tick();

    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [jobId, settled, poll]);

  // No job means this campaign predates the video pipeline, or its render was
  // never queued. Saying nothing beats showing a broken-looking empty card on
  // every older campaign.
  if (!jobId) return null;

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold">Streaming pre-roll</h2>
        <StateBadge state={status?.state ?? "queued"} label={status?.label ?? "Queued"} />
      </div>

      <p className="mt-1 text-xs text-[var(--color-muted)]">
        Five seconds, 1920&times;1080, built from this campaign&rsquo;s approved copy and palette.
      </p>

      {error && <p className="mt-3 text-sm text-[var(--color-danger,#f87171)]">{error}</p>}

      {status?.state === "failed" && (
        <p className="mt-3 text-sm text-[var(--color-danger,#f87171)]">
          Rendering failed{status.errorCode ? ` (${status.errorCode})` : ""}. Editing the campaign
          queues a fresh attempt.
        </p>
      )}

      {status?.state === "ready" && status.downloadUrl && (
        <div className="mt-4 space-y-3">
          {/* The poster is what a player shows before the first frame, so it is
              the honest still to preview here. */}
          {status.posterUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={status.posterUrl}
              alt=""
              className="w-full max-w-md rounded-lg border border-[var(--color-border,#2a2f3a)]"
            />
          )}
          <div className="flex flex-wrap items-center gap-3">
            <a href={status.downloadUrl} download className="btn btn-primary text-sm">
              Download MP4
            </a>
            <span className="text-xs text-[var(--color-muted)]">
              {formatBytes(status.downloadBytes)} &middot; revision {status.revision}
            </span>
          </div>
          <p className="text-xs text-[var(--color-muted)]">
            {status.streamingReady
              ? "Ready to stream. Downloading works whether or not the campaign is active."
              : "Downloadable, but not yet complete for streaming."}
          </p>
        </div>
      )}

      {status && !settled && (
        <p className="mt-3 text-sm text-[var(--color-muted)]">
          This runs in the background. You can leave the page; saving and editing the campaign
          never waits on it.
        </p>
      )}
    </div>
  );
}

function StateBadge({ state, label }: { state: string; label: string }) {
  const tone =
    state === "ready"
      ? "var(--color-accent, #6ee7b7)"
      : state === "failed"
        ? "var(--color-danger, #f87171)"
        : "var(--color-muted, #98a2b3)";
  return (
    <span
      className="rounded-full px-3 py-1 text-xs font-medium"
      style={{ color: tone, border: `1px solid ${tone}` }}
    >
      {label}
    </span>
  );
}

function formatBytes(n: number | null): string {
  if (!n) return "—";
  const mb = n / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}
