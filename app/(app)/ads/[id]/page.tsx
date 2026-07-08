import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { AdCreative, AdFormatId } from "@/lib/ads/formats";
import { AdPreview } from "@/components/ads/ad-preview";
import { CampaignActions, RegenerateButton } from "@/components/ads/campaign-actions";
import { CampaignTrend } from "@/components/ads/campaign-trend";
import { getCampaignDailySeries } from "@/lib/ads/series";

export const metadata = { title: "Campaign" };

type CreativeRow = {
  id: string;
  format: AdFormatId;
  headline: string;
  body: string;
  cta_text: string;
  image_url: string | null;
  logo_url: string | null;
  bg_color: string;
  fg_color: string;
  accent_color: string;
  font_family: string;
};

function dollars(cents: number): string {
  return `$${((cents ?? 0) / 100).toFixed(2)}`;
}

function ctr(clicks: number, impressions: number): string {
  if (!impressions) return "—";
  return `${((clicks / impressions) * 100).toFixed(1)}%`;
}

export default async function CampaignDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) notFound();

  const { data: campaign } = await supabase
    .from("ad_campaigns")
    .select(
      "id, name, destination_url, destination_domain, daily_budget_cents, bid_credits, status, ref_slug, created_at, spend_today_cents, total_spent_cents",
    )
    .eq("id", id)
    .eq("owner_id", user.id)
    .maybeSingle();
  if (!campaign) notFound();

  const [{ data: stats }, { data: creativeRows }, series] = await Promise.all([
    supabase
      .from("ad_campaign_stats")
      .select("impressions, clicks")
      .eq("campaign_id", id)
      .maybeSingle(),
    supabase
      .from("ad_creatives")
      .select(
        "id, format, headline, body, cta_text, image_url, logo_url, bg_color, fg_color, accent_color, font_family",
      )
      .eq("campaign_id", id)
      .order("format"),
    getCampaignDailySeries(supabase, [id], 30),
  ]);

  const impressions = (stats?.impressions as number) ?? 0;
  const clicks = (stats?.clicks as number) ?? 0;
  const daily = series.get(id) ?? [];

  const creatives: (AdCreative & { id: string })[] = ((creativeRows as CreativeRow[]) ?? []).map(
    (r) => ({
      id: r.id,
      format: r.format,
      headline: r.headline,
      body: r.body,
      ctaText: r.cta_text,
      bgColor: r.bg_color,
      fgColor: r.fg_color,
      accentColor: r.accent_color,
      fontFamily: r.font_family,
      logoUrl: r.logo_url,
      imageUrl: r.image_url,
    }),
  );

  return (
    <div className="mx-auto max-w-4xl">
      <Link href="/ads" className="text-sm text-[var(--color-muted)]">
        ← Ad campaigns
      </Link>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-3xl font-bold">{campaign.name}</h1>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            {campaign.destination_domain && (
              <a
                href={campaign.destination_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--color-accent)] hover:underline"
              >
                {campaign.destination_domain}
              </a>
            )}{" "}
            · {dollars(campaign.daily_budget_cents)}/day ·{" "}
            <span className="font-mono">{campaign.ref_slug}</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="badge whitespace-nowrap">{campaign.status}</span>
          <Link href={`/ads/${id}/edit`} className="btn text-sm">
            Edit
          </Link>
          <RegenerateButton id={id} />
          <CampaignActions id={id} status={campaign.status} />
        </div>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Impressions" value={impressions.toLocaleString()} />
        <Stat label="Clicks" value={clicks.toLocaleString()} />
        <Stat label="CTR" value={ctr(clicks, impressions)} />
        <Stat label="Total spend" value={dollars(campaign.total_spent_cents)} />
        <Stat label="Today" value={dollars(campaign.spend_today_cents)} />
        <Stat label="Daily budget" value={dollars(campaign.daily_budget_cents)} />
      </div>

      <div className="mt-4">
        <CampaignTrend data={daily} />
      </div>

      {creatives.length > 0 && (
        <div className="mt-6">
          <h2 className="mb-3 font-semibold">Creatives</h2>
          <div className="flex flex-wrap gap-4">
            {creatives.map((c) => (
              <div key={c.id} className="card p-3">
                <AdPreview creative={c} />
                <div className="mt-2 text-center text-xs text-[var(--color-muted)]">
                  {c.format.replace("banner_", "").replace("x", " × ")}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card p-4">
      <div className="text-xs uppercase tracking-wider text-[var(--color-muted)]">{label}</div>
      <div className="mt-1 text-2xl font-bold">{value}</div>
    </div>
  );
}
