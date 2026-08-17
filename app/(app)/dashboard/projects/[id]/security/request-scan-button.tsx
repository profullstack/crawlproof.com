"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { requestPortScan } from "@/app/actions/portScans";

type ScanStatus = "queued" | "running" | "done" | "failed";

const STATUS_LABEL: Record<ScanStatus, string> = {
  queued: "Queued…",
  running: "Scanning…",
  done: "Done",
  failed: "Failed",
};
const STATUS_COLOR: Record<ScanStatus, string> = {
  queued: "var(--color-muted)",
  running: "var(--color-warn)",
  done: "var(--color-pass)",
  failed: "var(--color-fail)",
};

export function RequestScanButton({
  projectId,
  activeScanId = null,
}: {
  projectId: string;
  activeScanId?: string | null;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<ScanStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const subscribe = useCallback(
    (scanId: string) => {
      esRef.current?.close();
      const es = new EventSource(
        `/dashboard/projects/${projectId}/security/stream?scanId=${encodeURIComponent(scanId)}`,
      );
      esRef.current = es;
      setBusy(true);

      es.addEventListener("status", (e) => {
        const d = JSON.parse((e as MessageEvent).data);
        setStatus(d.status as ScanStatus);
      });
      es.addEventListener("done", (e) => {
        const d = JSON.parse((e as MessageEvent).data);
        setStatus(d.scan.status as ScanStatus);
        es.close();
        setBusy(false);
        // Pull the freshly-persisted findings + history into the server render.
        router.refresh();
      });
      es.onerror = () => {
        es.close();
        setBusy(false);
      };
    },
    [projectId, router],
  );

  // Resume streaming if a scan is already in flight when the page loads.
  useEffect(() => {
    if (activeScanId) subscribe(activeScanId);
    return () => esRef.current?.close();
  }, [activeScanId, subscribe]);

  async function run() {
    setError(null);
    setBusy(true);
    setStatus("queued");
    const res = await requestPortScan(projectId);
    if (!res.ok || !res.scanId) {
      setError(res.error ?? "Failed to queue scan.");
      setStatus(null);
      setBusy(false);
      return;
    }
    subscribe(res.scanId);
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        {status && (
          <span
            className="text-xs font-semibold"
            style={{ color: STATUS_COLOR[status] }}
          >
            {status === "running" && (
              <span className="mr-1 inline-block animate-pulse">●</span>
            )}
            {STATUS_LABEL[status]}
          </span>
        )}
        <button
          onClick={run}
          disabled={busy}
          className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-semibold text-[var(--color-accent-fg)] disabled:opacity-60"
        >
          {busy ? "Working…" : "Run scan"}
        </button>
      </div>
      {error && <p className="text-xs text-[var(--color-fail)]">{error}</p>}
    </div>
  );
}
