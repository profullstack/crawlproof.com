import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProjectById } from "@/lib/lx/currentSite";
import { siteEndpointConfig } from "@/lib/webhooks/hub";
import { SetupForm } from "./form";

export const metadata = { title: "Autoblog · Setup" };

const SITE_COLUMNS =
  "id, domain, blog_root_url, sitemap_url, niche, target_audiences, description, seed_keywords, master_keywords, modifiers, preserve_keywords, ads_enabled, keywords, seo_title, seo_description, tone, competitors, webhook_url, webhook_secret, webhook_endpoint_id, daily_article_count, publish_days, publish_hour, internal_links_per_article, backlinks_enabled, external_links_per_article, banner_style, status";

export default async function AutoblogSetupPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ new?: string }>;
}) {
  const { id: projectId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const project = await getProjectById(projectId, {
    siteColumns: SITE_COLUMNS,
    projectColumns: "id, name, url",
  });
  if (!project) notFound();

  const sp = await searchParams;
  const isNew = sp?.new === "1";
  const site = isNew ? null : project.lx_site;
  const lxSiteId =
    site && typeof (site as { id?: unknown }).id === "string"
      ? ((site as { id: string }).id)
      : null;
  const [
    { count: queuedKeywords },
    { count: failedKeywords },
    { data: latestKeywordFailure },
  ] = lxSiteId
    ? await Promise.all([
        supabase
          .from("lx_keyword")
          .select("id", { count: "exact", head: true })
          .eq("site_id", lxSiteId)
          .eq("status", "queued"),
        supabase
          .from("lx_keyword")
          .select("id", { count: "exact", head: true })
          .eq("site_id", lxSiteId)
          .eq("status", "failed"),
        supabase
          .from("lx_keyword")
          .select("keyword, created_at")
          .eq("site_id", lxSiteId)
          .eq("status", "failed")
          .ilike("keyword", "Keyword research failed:%")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ])
    : [{ count: 0 }, { count: 0 }, { data: null }];

  // The webhook fields show the hub endpoint (the source of truth since the
  // move to @profullstack/webhooks), so a secret rotated on the Webhooks page
  // or through the API is what the form shows and re-saves.
  const hubEndpoint = site
    ? await siteEndpointConfig((site as { webhook_endpoint_id?: string | null }).webhook_endpoint_id).catch(() => null)
    : null;
  const initial = site
    ? {
        ...(site as Record<string, unknown>),
        ...(hubEndpoint ? { webhook_url: hubEndpoint.url, webhook_secret: hubEndpoint.secret } : {}),
      }
    : null;

  return (
    <div className="max-w-3xl">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 className="text-xl font-bold">
          {site ? "Autoblog settings" : "Set up Autoblog"}
        </h2>
        <div className="flex flex-wrap gap-2">
          <Link href={`/dashboard/projects/${projectId}/autoblog`} className="btn">
            Dashboard
          </Link>
          <Link href={`/dashboard/projects/${projectId}/autoblog/history`} className="btn">
            History
          </Link>
          <Link href={`/dashboard/projects/${projectId}/autoblog/backlinks`} className="btn">
            Backlinks
          </Link>
          <Link href={`/dashboard/projects/${projectId}/autoblog/webhooks`} className="btn">
            Webhooks
          </Link>
        </div>
      </div>
      <p className="mt-2 text-sm text-[var(--color-muted)]">
        We auto-generate a daily SEO blog post for your site and POST it to
        your webhook. You handle publishing. When backlink exchange is enabled,
        the History page shows partner backlinks and guest posts.
      </p>
      <SetupForm
        projectId={projectId}
        initial={(initial as any) ?? null}
        initialQueuedCount={queuedKeywords ?? 0}
        initialFailedCount={failedKeywords ?? 0}
        initialKeywordFailure={
          typeof latestKeywordFailure?.keyword === "string"
            ? latestKeywordFailure.keyword
            : null
        }
      />
    </div>
  );
}
