import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { formatSpec, type AdCreative, type AdFormatId } from "@/lib/ads/formats";
import { AdPreview } from "@/components/ads/ad-preview";
import { CampaignActions, RegenerateButton } from "@/components/ads/campaign-actions";
import { CampaignTrend } from "@/components/ads/campaign-trend";
import { BidHistory } from "@/components/ads/bid-history";
import { getCampaignDailySeries } from "@/lib/ads/series";
import { getBidHistory } from "@/lib/ads/bids";
import { paperSpendTodayCents } from "@/lib/ads/autobid";
import { serviceClient } from "@/lib/supabase/service";
import { campaignDisplayStatus, spendTodayCents, utcToday } from "@/lib/ads/status";
import { promoStateForCampaign } from "@/lib/ads/promos";
import { CREDIT_CENTS, DEFAULT_BID_CREDITS, TRENDING_CPC_CENTS } from "@/lib/ads/pricing";

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
  light_bg_color: string | null;
  light_fg_color: string | null;
  light_accent_color: string | null;
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
      "id, name, destination_url, destination_domain, daily_budget_cents, bid_credits, status, ref_slug, created_at, spend_today_cents, spend_date, total_spent_cents",
    )
    .eq("id", id)
    .eq("owner_id", user.id)
    .maybeSingle();
  if (!campaign) notFound();

  const [{ data: stats }, { data: creativeRows }, series, { data: profile }] = await Promise.all([
    supabase
      .from("ad_campaign_stats")
      .select("impressions, free_impressions, clicks, free_clicks")
      .eq("campaign_id", id)
      .maybeSingle(),
    supabase
      .from("ad_creatives")
      .select(
        "id, format, headline, body, cta_text, image_url, logo_url, bg_color, fg_color, accent_color, light_bg_color, light_fg_color, light_accent_color, font_family",
      )
      .eq("campaign_id", id)
      .order("format"),
    getCampaignDailySeries(supabase, [id], 30),
    supabase
      .from("profiles")
      .select("credits_balance, ad_bonus_credits")
      .eq("id", user.id)
      .maybeSingle(),
  ]);

  // The promo is its own read: it lives in ad_promos, and the row may not
  // exist at all (nobody has enabled trending targeting, or the migration has
  // not been applied here yet). Both read as "no promo".
  const promo = await promoStateForCampaign(supabase, id);

  // The bid, who sets it, and its paper ledger: their own read too, for the
  // same reason — the columns ride behind a hand-applied migration and a
  // missing one must not 404 the campaign. The history comes through the
  // service client because the tracker rollup it joins is not readable by a
  // session, and ownership was already settled by the select above.
  type BidRow = {
    autobid?: boolean | null;
    paper_spend_today_cents?: number | null;
    paper_spend_date?: string | null;
    paper_total_cents?: number | null;
  };
  let bidRow: BidRow | null = null;
  try {
    const { data } = await supabase
      .from("ad_campaigns")
      .select("autobid, paper_spend_today_cents, paper_spend_date, paper_total_cents")
      .eq("id", id)
      .maybeSingle();
    bidRow = (data as BidRow | null) ?? null;
  } catch {
    bidRow = null;
  }
  const autobid = bidRow?.autobid !== false;
  const bidCredits = campaign.bid_credits ?? DEFAULT_BID_CREDITS;
  const history = await getBidHistory(serviceClient(), {
    campaignId: id,
    refSlug: campaign.ref_slug,
    ownerId: user.id,
    currentBid: bidCredits,
    days: 30,
  });

  const impressions = (stats?.impressions as number) ?? 0;
  const clicks = (stats?.clicks as number) ?? 0;
  const freeImpressions = (stats?.free_impressions as number) ?? 0;
  const freeClicks = (stats?.free_clicks as number) ?? 0;
  const daily = series.data.get(id) ?? [];
  const today = utcToday();
  const creditsAvailable = (profile?.credits_balance ?? 0) + (profile?.ad_bonus_credits ?? 0);
  const display = campaignDisplayStatus(campaign, today, creditsAvailable);

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
      <Link href="/dashboard/ads" className="text-sm text-[var(--color-muted)]">
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
          <span className="badge whitespace-nowrap" title={display.hint}>
            {display.label}
          </span>
          <Link href={`/dashboard/ads/${id}/edit`} className="btn text-sm">
            Edit
          </Link>
          <RegenerateButton id={id} />
          <CampaignActions id={id} status={campaign.status} />
        </div>
      </div>

      {/* Free tier still serves, so key this on the tier rather than on
          `serving` — otherwise a campaign quietly running as backfill would
          look identical to one winning paid placements. */}
      {display.tier !== "paid" && (
        <p className="mt-4 rounded-md border border-[var(--color-border)] bg-[var(--color-surface,transparent)] p-3 text-sm text-[var(--color-muted)]">
          {display.hint}
        </p>
      )}

      {/* The 90 days. Shown whether or not it is still running, because
          "your clicks started costing money last Tuesday" is the single most
          useful thing this page can say to somebody on the promo. */}
      {promo.endsAt && (
        <p className="mt-4 rounded-md border border-[var(--color-border)] p-3 text-sm">
          {promo.active ? (
            <>
              <span className="font-semibold">Trending promo: </span>
              {promo.daysRemaining} day{promo.daysRemaining === 1 ? "" : "s"} left. Clicks are
              billed at <span className="font-mono">$0.00</span> until{" "}
              {promo.endsAt.slice(0, 10)}, then{" "}
              <span className="font-mono">${(TRENDING_CPC_CENTS / 100).toFixed(2)}</span> per click.
            </>
          ) : (
            <>
              <span className="font-semibold">Trending promo ended </span>
              {promo.endsAt.slice(0, 10)}. Clicks bill normally.
            </>
          )}
        </p>
      )}

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Impressions" value={impressions.toLocaleString()} />
        <Stat label="Clicks" value={clicks.toLocaleString()} />
        <Stat label="CTR" value={ctr(clicks, impressions)} />
        <Stat label="Total spend" value={dollars(campaign.total_spent_cents)} />
        <Stat label="Today" value={dollars(spendTodayCents(campaign, today))} />
        <Stat label="Daily budget" value={dollars(campaign.daily_budget_cents)} />
      </div>

      {/* Counted apart from the paid figures above so the CTR and CPC an
          advertiser reads stay comparable across tiers. */}
      {(freeImpressions > 0 || freeClicks > 0) && (
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Stat label="Free impressions" value={freeImpressions.toLocaleString()} />
          <Stat label="Free clicks" value={freeClicks.toLocaleString()} />
          <Stat label="Free tier cost" value="$0.00" />
        </div>
      )}

      {/* The bid and its paper ledger. Paper is what the free-tier clicks would
          have cost at the bid — real numbers, no money moved — so the auction
          and the pacing can be read and judged before anybody is billed. */}
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat
          label={autobid ? "Bid (autobid)" : "Bid (set by hand)"}
          value={`${bidCredits} cr`}
          note={`$${((bidCredits * CREDIT_CENTS) / 100).toFixed(2)} per click`}
        />
        <Stat
          label="Paper spend today"
          value={dollars(bidRow ? paperSpendTodayCents({ daily_budget_cents: campaign.daily_budget_cents, ...bidRow }, today) : 0)}
          note="what free-tier clicks would have cost"
        />
        <Stat
          label="Paper spend total"
          value={dollars(Number(bidRow?.paper_total_cents ?? 0))}
          note="no credits were moved"
        />
      </div>

      <div className="mt-4">
        <CampaignTrend data={daily} />
      </div>

      <div className="mt-4">
        <BidHistory data={history.days} events={history.events} autobid={autobid} failed={history.failed} />
      </div>

      {creatives.length > 0 && (
        <div className="mt-6">
          <h2 className="mb-3 font-semibold">Creatives</h2>
          <div className="flex flex-wrap gap-4">
            {creatives.map((c) => (
              <div key={c.id} className="card p-3">
                <AdPreview creative={c} />
                <div className="mt-2 text-center text-xs text-[var(--color-muted)]">
                  {formatSpec(c.format).label}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="card p-4">
      <div className="text-xs uppercase tracking-wider text-[var(--color-muted)]">{label}</div>
      <div className="mt-1 text-2xl font-bold">{value}</div>
      {note && <div className="mt-0.5 text-xs text-[var(--color-muted)]">{note}</div>}
    </div>
  );
}
