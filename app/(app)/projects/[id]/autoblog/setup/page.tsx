import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProjectById } from "@/lib/lx/currentSite";
import { SetupForm } from "./form";

export const metadata = { title: "Autoblog · Setup" };

const SITE_COLUMNS =
  "id, domain, blog_root_url, sitemap_url, niche, target_audiences, description, seed_keywords, modifiers, preserve_keywords, keywords, seo_title, seo_description, tone, competitors, webhook_url, webhook_secret, daily_article_count, publish_days, publish_hour, internal_links_per_article, backlinks_enabled, external_links_per_article, status";

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

  return (
    <div className="max-w-3xl">
      <h2 className="text-xl font-bold">
        {site ? "Autoblog settings" : "Set up Autoblog"}
      </h2>
      <p className="mt-2 text-sm text-[var(--color-muted)]">
        We auto-generate a daily SEO blog post for your site and POST it to
        your webhook. You handle publishing. Link Exchange ships later —
        for now, articles include internal links from your sitemap only.
      </p>
      <SetupForm projectId={projectId} initial={(site as any) ?? null} />
    </div>
  );
}
