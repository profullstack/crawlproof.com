"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Promote pages are server-rendered, so posts made by the worker don't appear
// until a navigation. This re-fetches the server component on an interval (and
// immediately when the tab regains focus) so the "Posts sent", "Last posted",
// and post history stay live without a manual refresh. Pauses while the tab is
// hidden to avoid pointless load.
export function AutoRefresh({ intervalMs = 15000 }: { intervalMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const t = setInterval(tick, intervalMs);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [router, intervalMs]);

  return null;
}
