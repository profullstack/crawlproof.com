import type { MetadataRoute } from "next";
import { env } from "@/lib/env";
import { posts } from "@/lib/blog/posts";
import { serviceClient } from "@/lib/supabase/service";

// Regenerate hourly so new free scans show up in the index without a deploy.
export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = env.siteUrl.replace(/\/$/, "");
  const now = new Date();
  const staticEntries: MetadataRoute.Sitemap = [
    { url: `${base}/`, lastModified: now, changeFrequency: "weekly", priority: 1.0 },
    { url: `${base}/pricing`, lastModified: now, changeFrequency: "monthly", priority: 0.9 },
    { url: `${base}/about`, lastModified: now, changeFrequency: "monthly", priority: 0.7 },
    { url: `${base}/blog`, lastModified: now, changeFrequency: "weekly", priority: 0.8 },
    { url: `${base}/recent`, lastModified: now, changeFrequency: "hourly", priority: 0.9 },
    { url: `${base}/bot`, lastModified: now, changeFrequency: "monthly", priority: 0.5 },
    { url: `${base}/privacy`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${base}/terms`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    ...posts.map((p) => ({
      url: `${base}/blog/${p.slug}`,
      lastModified: new Date(p.date),
      changeFrequency: "monthly" as const,
      priority: 0.6,
    })),
    // Paginated /recent pages so crawlers can walk them.
    ...[2, 3, 4, 5].map((page) => ({
      url: `${base}/recent?page=${page}`,
      lastModified: now,
      changeFrequency: "hourly" as const,
      priority: 0.7,
    })),
  ];

  // Include the most recent anonymous reports as deep links so they get
  // indexed. We cap at 100 to mirror the /recent UI and keep sitemap size
  // reasonable; older audits drop out as new ones come in.
  let reportEntries: MetadataRoute.Sitemap = [];
  try {
    const svc = serviceClient();
    const { data } = await svc
      .from("audits")
      .select("share_token, completed_at, created_at")
      .is("owner_id", null)
      .eq("status", "complete")
      .not("share_token", "is", null)
      .order("completed_at", { ascending: false })
      .limit(100);
    reportEntries = (data ?? []).map((r) => ({
      url: `${base}/r/${r.share_token}`,
      lastModified: new Date(
        (r.completed_at as string | null) ?? (r.created_at as string),
      ),
      changeFrequency: "monthly" as const,
      priority: 0.6,
    }));
  } catch {
    // Don't 500 the sitemap if Supabase is briefly unreachable.
  }

  return [...staticEntries, ...reportEntries];
}
