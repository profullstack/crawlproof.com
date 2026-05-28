"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const REFRESH_INTERVAL_MS = 15000;

export function SocialAutoRefresh() {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => router.refresh(), REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [router]);
  return null;
}
