import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentSite } from "@/lib/lx/currentSite";
import { SetupForm } from "./form";

export const metadata = { title: "Autoblog · Setup" };

const SITE_COLUMNS =
  "id, domain, blog_root_url, sitemap_url, niche, target_audiences, description, keywords, seo_title, seo_description, tone, competitors, webhook_url, webhook_secret, daily_article_count, publish_days, publish_hour, internal_links_per_article, backlinks_enabled, external_links_per_article, status";

export default async function AutoblogSetupPage({
  searchParams,
}: {
  searchParams: Promise<{ new?: string }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // ?new=1 forces the discover wizard, used by "+ New site" in the
  // picker. Otherwise resolve the active site via the picker cookie.
  const params = await searchParams;
  const isNew = params?.new === "1";
  const site = isNew ? null : await getCurrentSite(SITE_COLUMNS);

  return (
    <div className="mx-auto max-w-2xl">
      <Link href="/dashboard" className="text-sm text-[var(--color-muted)]">
        ← Dashboard
      </Link>
      <h1 className="mt-4 text-3xl font-bold">
        {site ? "Autoblog settings" : "Set up Autoblog"}
      </h1>
      <p className="mt-2 text-[var(--color-muted)]">
        We auto-generate a daily SEO blog post for your site and POST it to
        your webhook. You handle publishing. Link Exchange ships later — for now,
        articles include internal links from your sitemap only.
      </p>
      <SetupForm initial={(site as any) ?? null} />
    </div>
  );
}
