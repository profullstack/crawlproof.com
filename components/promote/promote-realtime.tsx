"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// Live-updates the (server-rendered) Promote pages via Supabase Realtime:
// subscribes to inserts/updates on promo_post and promo_list and re-fetches the
// server component when they change. RLS scopes realtime to the signed-in
// user's own rows, so no explicit user filter is needed; pass `listId` on the
// detail page to narrow the stream to a single list. Refreshes are debounced so
// a burst of posts (one per connected account) coalesces into one re-fetch.
export function PromoteRealtime({ listId }: { listId?: string }) {
  const router = useRouter();
  // Keep a stable ref to router so the effect doesn't resubscribe on refresh.
  const refresh = useRef(() => router.refresh());
  refresh.current = () => router.refresh();

  useEffect(() => {
    const supabase = createClient();
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const bump = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => refresh.current(), 400);
    };

    const postFilter = listId ? { filter: `list_id=eq.${listId}` } : {};
    const listFilter = listId ? { filter: `id=eq.${listId}` } : {};

    const channel = supabase
      .channel(`promote-realtime${listId ? `-${listId}` : ""}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "promo_post", ...postFilter },
        bump,
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "promo_list", ...listFilter },
        bump,
      )
      .subscribe();

    return () => {
      if (debounce) clearTimeout(debounce);
      supabase.removeChannel(channel);
    };
  }, [listId]);

  return null;
}
