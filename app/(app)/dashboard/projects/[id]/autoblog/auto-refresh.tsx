"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Periodically calls router.refresh() while `active` is true so the
// autoblog dashboard can transition from "1 generating" → "preview ready"
// without the user manually reloading. The parent decides when this is
// active (passes `inFlightCount > 0`); the component stops cleanly when
// that flips to false.
//
// 8s cadence balances responsiveness against server load — generation
// itself takes 1–3 min, so polling much faster than this is wasted.
const REFRESH_INTERVAL_MS = 8000;

export function AutoblogAutoRefresh({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => router.refresh(), REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [active, router]);
  return null;
}
