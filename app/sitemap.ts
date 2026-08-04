import type { MetadataRoute } from "next";
import { buildSitemapBlogEntries } from "@profullstack/autoblog/feeds";
import { env } from "@/lib/env";
import { loadAllPosts } from "@/lib/blog/posts";
import { serviceClient } from "@/lib/supabase/service";

// Regenerate hourly so new public scans show up in the index without a deploy.
export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = env.siteUrl.replace(/\/$/, "");
  const allPosts = await loadAllPosts();
  const staticEntries: MetadataRoute.Sitemap = [
    { url: `${base}/`, changeFrequency: "weekly", priority: 1.0 },
    { url: `${base}/pricing`, changeFrequency: "monthly", priority: 0.9 },
    { url: `${base}/hire`, changeFrequency: "monthly", priority: 0.9 },
    { url: `${base}/slop`, changeFrequency: "monthly", priority: 0.9 },
    { url: `${base}/get-guide`, changeFrequency: "monthly", priority: 0.9 },
    { url: `${base}/about`, changeFrequency: "monthly", priority: 0.7 },
    { url: `${base}/press`, changeFrequency: "monthly", priority: 0.6 },
    { url: `${base}/blog`, changeFrequency: "weekly", priority: 0.8 },
    { url: `${base}/recent`, changeFrequency: "hourly", priority: 0.9 },
    { url: `${base}/bot`, changeFrequency: "monthly", priority: 0.5 },
    { url: `${base}/privacy`, changeFrequency: "yearly", priority: 0.3 },
    { url: `${base}/terms`, changeFrequency: "yearly", priority: 0.3 },
    ...buildSitemapBlogEntries({
      posts: allPosts.map((p) => ({
        slug: p.slug,
        title: p.title,
        publishedAt: p.date,
      })),
      baseUrl: base,
    }),
    // Paginated /recent pages so crawlers can walk them.
    ...[2, 3, 4, 5].map((page) => ({
      url: `${base}/recent?page=${page}`,
      changeFrequency: "hourly" as const,
      priority: 0.7,
    })),
  ];

  // Include the most recent opted-in reports as deep links so they get
  // indexed. We cap at 100 to mirror the /recent UI and keep sitemap size
  // reasonable; older audits drop out as new ones come in.
  let reportEntries: MetadataRoute.Sitemap = [];
  try {
    const svc = serviceClient();
    const { data } = await svc
      .from("audits")
      .select("share_token, completed_at, created_at")
      .eq("listed_public", true)
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

  // Hosted job boards and the individual postings under them. These exist so
  // that a client-rendered careers widget still has crawlable HTML behind it —
  // which only pays off if crawlers can find the pages, so they belong here.
  let careerEntries: MetadataRoute.Sitemap = [];
  try {
    const svc = serviceClient();
    // Two queries rather than an embedded join: the serving RPC gates on both
    // flags, so the sitemap has to gate on them too or it advertises boards
    // that 404 — and resolving the enabled set first says that plainly.
    const { data: enabled } = await svc
      .from("projects")
      .select("id")
      .eq("careers_enabled", true)
      .eq("tracker_enabled", true);
    const enabledIds = ((enabled ?? []) as Array<{ id: string }>).map((p) => p.id);

    if (enabledIds.length > 0) {
      const { data } = await svc
        .from("job_postings")
        .select("slug, project_id, published_at, updated_at")
        .eq("status", "open")
        .in("project_id", enabledIds)
        .order("published_at", { ascending: false })
        .limit(500);

      const rows = (data ?? []) as Array<{
        slug: string;
        project_id: string;
        published_at: string | null;
        updated_at: string | null;
      }>;

      const boards = new Set(rows.map((r) => r.project_id));
      careerEntries = [
        ...Array.from(boards).map((projectId) => ({
          url: `${base}/c/${projectId}`,
          changeFrequency: "daily" as const,
          priority: 0.7,
        })),
        ...rows.map((row) => ({
          url: `${base}/c/${row.project_id}/${row.slug}`,
          lastModified: new Date(row.updated_at ?? row.published_at ?? Date.now()),
          changeFrequency: "weekly" as const,
          priority: 0.6,
        })),
      ];
    }
  } catch {
    // Same rule as above — a sitemap missing job pages beats a 500.
  }

  return [...staticEntries, ...reportEntries, ...careerEntries];
}
