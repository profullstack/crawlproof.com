"use client";

import { useEffect, useState } from "react";

function fmtDuration(ms: number): string {
  if (ms <= 0) return "now";
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (days > 0) return `in ${days}d ${hours}h`;
  if (hours > 0) return `in ${hours}h ${minutes}m`;
  if (minutes > 0) return `in ${minutes}m ${seconds}s`;
  return `in ${seconds}s`;
}

export function Countdown({ targetIso }: { targetIso: string | null }) {
  // Render the static fallback during SSR / pre-hydration so we don't
  // diverge from the server-rendered HTML.
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    if (!targetIso) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [targetIso]);

  if (!targetIso) return <>—</>;

  const target = new Date(targetIso).getTime();
  if (now === null) {
    // SSR-safe placeholder: show the absolute time.
    try {
      return (
        <>
          {new Date(targetIso).toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </>
      );
    } catch {
      return <>{targetIso}</>;
    }
  }

  return <>{fmtDuration(target - now)}</>;
}
