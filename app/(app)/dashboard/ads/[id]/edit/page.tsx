import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { AdCreative, AdFormatId } from "@/lib/ads/creative";
import { EditCampaignForm } from "./edit-form";

export const metadata = { title: "Edit campaign" };

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
  light_bg_color: string | null;
  light_fg_color: string | null;
  light_accent_color: string | null;
  font_family: string;
};

export default async function EditCampaignPage({
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
    .select("id, name, destination_url, daily_budget_cents, bid_credits, status, ref_slug")
    .eq("id", id)
    .eq("owner_id", user.id)
    .maybeSingle();
  if (!campaign) notFound();

  const { data: creativeRows } = await supabase
    .from("ad_creatives")
    .select("id, format, headline, body, cta_text, image_url, logo_url, bg_color, fg_color, accent_color, light_bg_color, light_fg_color, light_accent_color, font_family")
    .eq("campaign_id", id)
    .order("format");

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
      lightBgColor: r.light_bg_color,
      lightFgColor: r.light_fg_color,
      lightAccentColor: r.light_accent_color,
      fontFamily: r.font_family,
      logoUrl: r.logo_url,
      imageUrl: r.image_url,
    }),
  );

  return (
    <div className="mx-auto max-w-4xl">
      <Link href={`/dashboard/ads/${id}`} className="text-sm text-[var(--color-muted)]">
        ← Campaign
      </Link>
      <div className="mt-4 flex items-center justify-between gap-3">
        <h1 className="text-3xl font-bold">Edit campaign</h1>
        <span className="badge font-mono">{campaign.ref_slug}</span>
      </div>
      <EditCampaignForm
        campaign={{
          id: campaign.id,
          name: campaign.name,
          destinationUrl: campaign.destination_url,
          dailyBudgetCents: campaign.daily_budget_cents,
          bidCredits: campaign.bid_credits ?? 4,
          status: campaign.status,
        }}
        creatives={creatives}
      />
    </div>
  );
}
