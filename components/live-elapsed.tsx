"use client";

import { useEffect, useState } from "react";

/**
 * Ticks every second so the user can see how long an in-flight engine
 * has been running. Renders a stable initial value during SSR so the
 * hydration diff is just the seconds update.
 */
export function LiveElapsed({ startedAt }: { startedAt: string | number }) {
  const start =
    typeof startedAt === "number"
      ? startedAt
      : new Date(startedAt).getTime();
  const [now, setNow] = useState(start);

  useEffect(() => {
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const ms = Math.max(0, now - start);
  return <span className="tabular-nums">{format(ms)}</span>;
}

function format(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}
