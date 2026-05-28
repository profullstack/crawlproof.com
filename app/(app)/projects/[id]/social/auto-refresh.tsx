"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Only polls while `active` — caller passes true when there are
// in-flight posts or the feed is mid-check. An idle social tab left
// open should not generate server load.
const REFRESH_INTERVAL_MS = 15000;

export function SocialAutoRefresh({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => router.refresh(), REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [active, router]);
  return null;
}
