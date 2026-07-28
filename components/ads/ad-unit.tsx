"use client";

import { useEffect } from "react";
import type { AdFormatId } from "@/lib/ads/formats";

// Our own slot on the network — the one this site earns from. Overridable so a
// preview/staging deploy can point at a test slot instead of billing the real
// one for impressions nobody sees.
const SLOT_ID =
  process.env.NEXT_PUBLIC_AD_SLOT_ID ?? "94cd644a-bcc2-4bba-ab66-b4a89f3727cc";

const SCRIPT_SRC = "/ad.js";

declare global {
  interface Window {
    crawlproofAds?: { scan: () => void };
  }
}

/**
 * A single ad container filled by /ad.js.
 *
 * Omitting `format` lets the script pick by container width (leaderboard on
 * desktop, mobile banner on narrow screens), which is what we want in the blog
 * column. The script only auto-scans once at load, so mounting a unit via
 * client-side navigation has to re-trigger the scan by hand.
 */
export function AdUnit({
  format,
  className,
}: {
  format?: AdFormatId;
  className?: string;
}) {
  useEffect(() => {
    if (window.crawlproofAds) {
      window.crawlproofAds.scan();
      return;
    }
    // First unit on the page loads the script; later ones ride the same tag.
    if (document.querySelector(`script[src="${SCRIPT_SRC}"]`)) return;
    const s = document.createElement("script");
    s.src = SCRIPT_SRC;
    s.async = true;
    document.body.appendChild(s);
  }, []);

  return (
    <div data-cp-ad data-slot={SLOT_ID} data-format={format} className={className} />
  );
}
