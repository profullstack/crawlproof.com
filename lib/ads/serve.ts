import crypto from "node:crypto";
import { serviceClient } from "@/lib/supabase/service";
import { env } from "@/lib/env";
import {
  AD_FORMAT_IDS,
  appendRef,
  renderCreativeHtml,
  renderCreativeText,
  type AdCreative,
  type AdFormatId,
} from "./creative";
import { fitAdFormat, FEED_FORMAT_ID, TERMINAL_FORMAT_ID } from "./formats";
import { isAdTheme, type AdTheme, type AdThemePref } from "./theme";
import { houseFill, HOUSE_AD_ROTATION_RATE } from "./house";
import { CREDIT_CENTS, DEFAULT_BID_CREDITS, PLATFORM_RATE } from "./pricing";
import {
  assessClickValidity,
  isBotDevice,
  isDuplicateImpression,
  CLICK_DEDUPE_WINDOW_MS,
  IMPRESSION_DEDUPE_WINDOW_MS,
} from "./fraud";
import { hashIpRotating, rotatingIpHashCandidates } from "@/lib/ipHash";
import { runAuction } from "./auction";
import { generateShortCode } from "./shortcode";

// Server-side ad selection + metering. Runs under the service-role client so
// the public serving endpoints can read cross-tenant campaigns/creatives and
// append-write impressions/clicks. v1 is a flat, un-budgeted match: any active
// campaign with a ready creative in the requested format is eligible; we pick
// one at random to spread delivery. Auction + budget pacing are a later phase.

/**
 * Which inventory this fill came from.
 *
 * 'paid'  — won the auction; the click bills the advertiser and pays the publisher.
 * 'free'  — backfill from a campaign that ran out of credits or daily budget.
 *           Bills nobody, earns nobody, and only ever fills a request no paying
 *           campaign wanted. Beats showing a house ad.
 * 'house' — CrawlProof's own promo. Never metered.
 */
export type AdTier = "paid" | "free" | "house";

export type Fill = {
  impressionId: string;
  campaignId: string;
  creativeId: string;
  refSlug: string;
  creative: AdCreative;
  clickUrl: string;
  html: string;
  /** ASCII rendering of the same creative, for terminal/MOTD consumers. */
  text: string;
  tier: AdTier;
};

export function isAdFormat(v: string | null | undefined): v is AdFormatId {
  return !!v && (AD_FORMAT_IDS as string[]).includes(v);
}

// hashIp used to live here as a bare sha256(ip). It now comes from lib/ipHash,
// salted and rotating daily — see that module for why the ad path wants the
// rotating variant and the abuse caps want the stable one.

type CreativeRow = {
  id: string;
  campaign_id: string;
  format: AdFormatId;
  headline: string;
  body: string;
  cta_text: string;
  image_url: string | null;
  logo_url: string | null;
  bg_color: string;
  fg_color: string;
  accent_color: string;
  light_bg_color?: string | null;
  light_fg_color?: string | null;
  light_accent_color?: string | null;
  font_family: string;
};

function rowToCreative(r: CreativeRow): AdCreative {
  return {
    format: r.format,
    headline: r.headline,
    body: r.body,
    ctaText: r.cta_text,
    bgColor: r.bg_color,
    fgColor: r.fg_color,
    accentColor: r.accent_color,
    lightBgColor: r.light_bg_color ?? null,
    lightFgColor: r.light_fg_color ?? null,
    lightAccentColor: r.light_accent_color ?? null,
    fontFamily: r.font_family,
    logoUrl: r.logo_url,
    imageUrl: r.image_url,
  };
}

/**
 * Which polarity to render this fill in.
 *
 * The tag measures the publisher's actual page background and sends what it
 * found, which beats anything stored — a site can be redesigned between the
 * slot being created and the ad being served. The slot's own setting is the
 * fallback for surfaces that cannot measure anything: a MOTD over curl, a feed
 * spliced at build time, a page whose script was blocked.
 *
 * Dark is the final default because it is what every creative rendered as
 * before variants existed, so a request that says nothing gets exactly what it
 * got yesterday.
 */
export function resolveTheme(
  requested: string | null | undefined,
  slotDefault: string | null | undefined,
): AdTheme {
  const pref = resolveThemePref(requested, slotDefault);
  return pref === "auto" ? "dark" : pref;
}

/**
 * The same decision, but allowed to answer 'auto' — which is a real rendering
 * mode rather than a synonym for the default: the document ships both palettes
 * and `prefers-color-scheme` inside the frame picks. See `themeStyle`.
 *
 * An explicit light/dark still beats it from either side, because both of those
 * are somebody having actually looked: the tag measured the page, or a
 * publisher set the slot. 'auto' is what you fall back to when nothing did —
 * which is exactly the position `/api/ads/frame` is in, since a no-JS embed
 * cannot see the page it was pasted into.
 *
 * Callers that cannot honour a media query — a MOTD over curl, a feed body in
 * somebody's reader — go through `resolveTheme` above and collapse it to dark.
 */
export function resolveThemePref(
  requested: string | null | undefined,
  slotDefault: string | null | undefined,
): AdThemePref {
  if (isAdTheme(requested)) return requested;
  if (isAdTheme(slotDefault)) return slotDefault;
  if (requested === "auto" || slotDefault === "auto") return "auto";
  return "dark";
}

export type ServeContext = {
  visitorId?: string | null;
  ip?: string | null;
  country?: string | null;
  device?: string | null;
  /**
   * Publisher's surface tag (?src=bbs, ?src=ssh-banner, …). Recorded on the
   * impression rather than appended to the printed click URL, where it cost up
   * to 35 columns of a box that has 40. The click handler reads it back off the
   * row to build utm_content.
   */
  src?: string | null;
  /**
   * Polarity of the publisher's page, as measured by the tag. 'auto' (or
   * absent) falls back to the slot's stored default.
   */
  theme?: string | null;
  /**
   * Width in CSS pixels of the container the unit will sit in, as measured by
   * the tag. Absent for older tags and for the non-web consumers (MOTD, feed),
   * in which case the requested format is served unchanged.
   */
  width?: number | null;
};

// Returns a rendered fill for the slot, or null if the slot is inactive /
// no eligible ad exists. Records the impression as a side effect.
export async function serveAd(
  slotId: string,
  requestedFormat: AdFormatId,
  ctx: ServeContext = {},
): Promise<Fill | null> {
  const sb = serviceClient();

  const { data: slot } = await sb
    .from("ad_slots")
    .select("id, status, formats, owner_id, theme")
    .eq("id", slotId)
    .maybeSingle();
  if (!slot || slot.status !== "active") return null;

  // A unit wider than the container it was asked for loses its right-hand side
  // rather than shrinking, so the publisher's `data-format` is honoured only
  // while it fits. Constrained to the slot's own list, so this can never turn a
  // servable request into an empty fill. Callers read the format actually
  // served back off `fill.creative.format`.
  const format = fitAdFormat(requestedFormat, ctx.width, slot.formats);
  if (!format) return null;

  // `theme` rides behind `add column if not exists`, and migrations here are
  // applied by hand — a deploy that lands first would read undefined, which
  // resolveThemePref treats as "nobody said", the same as an absent request.
  const theme = resolveThemePref(ctx.theme, (slot as { theme?: string | null }).theme);

  // Bots get the house ad — never a paid impression (keeps advertiser stats
  // clean and avoids exposing paid creatives to crawlers).
  if (isBotDevice(ctx.device)) return houseFill(format, theme);

  // Campaigns with a ready creative in this format. 'exhausted' is a legacy
  // status no longer written by ad_charge_click — rows still carrying it are
  // live campaigns that ran dry, and belong on the free tier rather than dark.
  const { data: creatives } = await sb
    .from("ad_creatives")
    .select(
      "id, campaign_id, format, headline, body, cta_text, image_url, logo_url, bg_color, fg_color, accent_color, light_bg_color, light_fg_color, light_accent_color, font_family, ad_campaigns!inner(id, owner_id, status, ref_slug, destination_url, daily_budget_cents, spend_today_cents, spend_date, bid_credits)",
    )
    .eq("format", format)
    .eq("status", "ready")
    .in("ad_campaigns.status", ["active", "exhausted"])
    .limit(100);

  // No paid creative for this format → default CrawlProof house ad.
  if (!creatives || creatives.length === 0) return houseFill(format, theme);

  type CampaignJoin = {
    id: string;
    owner_id: string;
    ref_slug: string;
    destination_url: string;
    daily_budget_cents: number;
    spend_today_cents: number;
    spend_date: string | null;
    bid_credits: number;
  };
  type Row = CreativeRow & { ad_campaigns: CampaignJoin | CampaignJoin[] };
  const oneCampaign = (c: CampaignJoin | CampaignJoin[]): CampaignJoin =>
    Array.isArray(c) ? c[0] : c;
  const today = new Date().toISOString().slice(0, 10); // UTC yyyy-mm-dd

  // A self-owned campaign (same profile owns the slot and the campaign) can
  // never earn: ad_charge_click refuses to bill or accrue on a self-click. It
  // used to be dropped here outright, which is correct on a network with other
  // advertisers and catastrophic on one without — while every slot and every
  // campaign belong to the same account, that filter removed 100% of inventory
  // and every request fell through to the house ad. Serving stopped entirely
  // and nothing recorded an impression, because house fills aren't metered.
  //
  // So self-owned campaigns are demoted rather than discarded, below. Between a
  // real advertiser's creative and the house ad — neither of which can earn on
  // this request — the real creative is strictly the better fill.
  const candidates = (creatives as unknown as Row[]).filter(
    (row) => !!oneCampaign(row.ad_campaigns),
  );
  if (candidates.length === 0) return houseFill(format, theme);

  // A campaign is PAID-eligible only if its owner can actually cover a click at
  // its bid. Without this a broke campaign would win the auction and displace
  // one that can pay — the click would go unbilled and the publisher would earn
  // nothing on inventory a funded advertiser wanted.
  const ownerIds = [...new Set(candidates.map((r) => oneCampaign(r.ad_campaigns).owner_id))];
  const { data: owners } = await sb
    .from("profiles")
    .select("id, credits_balance, ad_bonus_credits")
    .in("id", ownerIds);
  const creditsByOwner = new Map(
    (owners ?? []).map((o) => [
      o.id as string,
      ((o.credits_balance as number) ?? 0) + ((o.ad_bonus_credits as number) ?? 0),
    ]),
  );

  const paid: Row[] = [];
  const free: Row[] = [];
  for (const row of candidates) {
    const c = oneCampaign(row.ad_campaigns);
    const bid = c.bid_credits ?? DEFAULT_BID_CREDITS;
    const spentToday = c.spend_date === today ? c.spend_today_cents : 0;
    const hasBudget = spentToday + bid * CREDIT_CENTS <= c.daily_budget_cents;
    const hasFunds = (creditsByOwner.get(c.owner_id) ?? 0) >= bid;
    // Same owner on both sides of the transaction: the click can't be billed,
    // so it must never win paid inventory ahead of an advertiser who would
    // actually pay. Free tier is exactly the right home for it — same place a
    // campaign that has run out of funds goes.
    const isSelfDeal = !!(slot.owner_id && c.owner_id === slot.owner_id);
    // Legacy 'exhausted' rows never compete for paid inventory on that status
    // alone — funds decide, and a top-up puts them straight back in the auction.
    (hasBudget && hasFunds && !isSelfDeal ? paid : free).push(row);
  }

  // Paid inventory first, always. Free-tier campaigns only ever fill requests no
  // paying advertiser wanted, so they can't cannibalise publisher earnings.
  let pick: Row | undefined;
  let tier: AdTier = "paid";

  if (paid.length > 0) {
    // Rotate the CrawlProof house ad into a slice of otherwise-fillable requests
    // so the ad network keeps promoting itself even on well-monetized slots.
    // Unmetered, so no paid impression is spent on these.
    if (Math.random() < HOUSE_AD_ROTATION_RATE) return houseFill(format, theme);

    // Bid-weighted lottery: every eligible campaign can win, with probability
    // proportional to its bid, so all active ads rotate (higher bids more often).
    pick = runAuction(
      paid.map((row) => ({
        bidCredits: oneCampaign(row.ad_campaigns).bid_credits ?? DEFAULT_BID_CREDITS,
        item: row,
      })),
    )?.winner;
  }

  // Nothing paid to show: backfill with a real advertiser's ad instead of the
  // house ad. Uniform pick, not bid-weighted — nobody is paying, so a high bid
  // buys no priority here.
  if (!pick && free.length > 0) {
    tier = "free";
    pick = free[Math.floor(Math.random() * free.length)];
  }

  if (!pick) return houseFill(format, theme);
  const campaign = oneCampaign(pick.ad_campaigns);
  if (!campaign) return null;

  // Record the impression first so we have an id to bind the click to.
  const ipHash = hashIpRotating(ctx.ip ?? null);
  const base = {
    slot_id: slotId,
    campaign_id: campaign.id,
    creative_id: pick.id,
    visitor_id: ctx.visitorId ?? null,
    ip_hash: ipHash,
    geo_country: ctx.country ?? null,
    device: ctx.device ?? null,
    billable: false,
    tier,
  };

  // Flag — never skip. The row still has to exist so /a/<short_code> can resolve
  // this exact campaign and creative; reporting excludes flagged rows instead.
  const duplicate = await isDuplicateImpression({
    slotId,
    visitorId: ctx.visitorId,
    ipHashes: rotatingIpHashCandidates(ctx.ip ?? null, IMPRESSION_DEDUPE_WINDOW_MS),
  });

  // The short code is what lets a terminal click URL fit inside the box, and
  // ctx.src records the publisher's surface tag on the row instead of in the
  // printed URL. Both live behind `add column if not exists`, and migrations
  // here are applied by hand — so if this deploy lands first, the insert would
  // fail on the unknown columns and take *all* paid serving down with it.
  // Retry once without them and fall back to the UUID click URL: a wide URL is
  // a cosmetic problem, a dropped impression is a lost sale.
  const shortCode = generateShortCode();
  let { data: imp } = await sb
    .from("ad_impressions")
    .insert({ ...base, short_code: shortCode, src: ctx.src ?? null, duplicate })
    .select("id, short_code")
    .single();

  if (!imp) {
    ({ data: imp } = await sb.from("ad_impressions").insert(base).select("id").single());
  }

  const impressionId = imp?.id ?? crypto.randomUUID();
  // Only address the click by code once we know the code was actually stored —
  // otherwise /a/<code> would resolve to nothing and the click would go
  // unmetered and unpaid.
  const clickRef =
    imp && "short_code" in imp && imp.short_code ? (imp.short_code as string) : impressionId;
  const creative = rowToCreative(pick);

  // Click goes through our redirector so we can meter it, then lands on the
  // destination with ?ref= applied. Terminals print the URL as literal text, so
  // the terminal format gets the short /a/<code> form — it resolves the
  // slot/campaign/creative from the impression row instead of the query string.
  //
  // Feed ads take the short form too, for two reasons. The soft one is that a
  // click URL in a feed is *seen*: readers show the destination on hover, and a
  // 70-character tracking URL beside a headline reads as spam next to
  // crawlproof.com/a/<code>. The hard one is that several feed shapes print it
  // as literal text rather than putting it in an href — as=text, as=markdown,
  // and the terminal body style, which renders the same fixed-width ASCII box
  // the MOTD endpoint serves and has exactly as little room to spare.
  const shortClick = format === TERMINAL_FORMAT_ID || format === FEED_FORMAT_ID;
  const clickUrl = shortClick
    ? `${env.siteUrl}/a/${clickRef}`
    : `${env.siteUrl}/api/ads/click?i=${impressionId}&s=${slotId}&c=${campaign.id}&cr=${pick.id}`;

  return {
    impressionId,
    campaignId: campaign.id,
    creativeId: pick.id,
    refSlug: campaign.ref_slug,
    creative,
    clickUrl,
    html: renderCreativeHtml(creative, clickUrl, { theme }),
    text: renderCreativeText(creative, clickUrl),
    tier,
  };
}

/**
 * A campaign's editorial prose, when it still describes where the campaign points.
 *
 * Deliberately a separate query rather than two more columns on the creative
 * join in serveAd. That join is *the* serving query — if it fails, every unit
 * on every slot goes dark — and these columns sit behind an `add column if not
 * exists` in a migration applied by hand, so a deploy can briefly run ahead of
 * the schema. One extra round trip on the feed path is a cheap price for not
 * being able to take banner and terminal serving down with it. Feed fills are
 * rare anyway: one per publisher build, not one per reader.
 *
 * Returns null when the columns are missing, the row is gone, the prose is
 * empty, or `summary_domain` disagrees with `destination_domain` — a campaign's
 * destination can be edited after generation, and prose confidently describing
 * a site the campaign no longer points at is worse than no prose.
 */
export async function campaignSummary(
  campaignId: string,
): Promise<{ short: string | null; long: string | null } | null> {
  if (!campaignId || campaignId === "house") return null;
  try {
    const sb = serviceClient();
    const { data, error } = await sb
      .from("ad_campaigns")
      .select("summary_short, summary_long, summary_domain, destination_domain")
      .eq("id", campaignId)
      .maybeSingle();
    if (error || !data) return null;

    const short = (data.summary_short as string | null) ?? null;
    const long = (data.summary_long as string | null) ?? null;
    if (!short && !long) return null;

    const wrote = String(data.summary_domain ?? "").toLowerCase();
    const points = String(data.destination_domain ?? "").toLowerCase();
    // No recorded domain means we cannot show it is still accurate.
    if (!wrote || (points && wrote !== points)) return null;

    return { short, long };
  } catch {
    // Unknown column, network, anything — the ad renders from its short body.
    return null;
  }
}

/**
 * The visitor this click belongs to.
 *
 * Prefers the id recorded on the impression over anything the caller passed.
 * That is both more accurate and safer: the impression's copy was written
 * server-side from the tag at serve time, whereas `?v=` on a click URL is
 * whatever the requester typed, and dedupe keys on it.
 *
 * This exists because the web click URL never carried `?v=` at all — only the
 * short /a/<code> form read it back off the impression — so every click on a
 * banner or text link arrived with a null visitor and deduped on IP alone.
 * 284 of 297 such clicks had an impression that knew the visitor; none of them
 * kept it. Two readers behind one NAT looked like one person clicking twice.
 */
async function resolveClickVisitor(
  sb: ReturnType<typeof serviceClient>,
  impressionId: string | null | undefined,
  fromCaller: string | null | undefined,
): Promise<string | null> {
  if (!impressionId) return fromCaller ?? null;
  try {
    const { data } = await sb
      .from("ad_impressions")
      .select("visitor_id")
      .eq("id", impressionId)
      .maybeSingle();
    return (data?.visitor_id as string | null | undefined) ?? fromCaller ?? null;
  } catch {
    // A lookup failure must never cost the publisher a click.
    return fromCaller ?? null;
  }
}

// Resolve a click: record it, return the destination URL (with ?ref=) to
// redirect to. Returns null if the campaign/creative can't be resolved.
export async function resolveClick(input: {
  impressionId?: string | null;
  slotId?: string | null;
  campaignId?: string | null;
  creativeId?: string | null;
  ctx?: ServeContext;
}): Promise<string | null> {
  const sb = serviceClient();
  if (!input.campaignId) return null;

  const { data: campaign } = await sb
    .from("ad_campaigns")
    .select("id, destination_url, ref_slug, status, bid_credits")
    .eq("id", input.campaignId)
    .maybeSingle();
  if (!campaign) return null;

  // slot_id must be present (ad_clicks.slot_id NOT NULL) to record a click.
  if (input.slotId) {
    const visitorId = await resolveClickVisitor(sb, input.impressionId, input.ctx?.visitorId);
    // The row is stored under today's salt; the dedupe lookup has to consider
    // yesterday's too, or every check silently misses for the first hours after
    // the salt rotates.
    const ipHash = hashIpRotating(input.ctx?.ip ?? null);
    const validity = await assessClickValidity({
      campaignId: campaign.id,
      slotId: input.slotId,
      impressionId: input.impressionId,
      visitorId,
      ipHashes: rotatingIpHashCandidates(input.ctx?.ip ?? null, CLICK_DEDUPE_WINDOW_MS),
      device: input.ctx?.device,
    });

    if (validity.valid) {
      // Atomic charge: debit advertiser credits, meter the click, accrue the
      // publisher share + platform fee (unbilled if out of budget/funds).
      await sb.rpc("ad_charge_click", {
        p_campaign: campaign.id,
        p_slot: input.slotId,
        p_creative: input.creativeId ?? null,
        p_impression: input.impressionId ?? null,
        p_visitor: visitorId,
        p_ip_hash: ipHash,
        p_country: input.ctx?.country ?? null,
        p_device: input.ctx?.device ?? null,
        // Charge the winning bid (first-price). Falls back to the default CPC.
        p_cpc_credits: campaign.bid_credits ?? DEFAULT_BID_CREDITS,
        p_platform_rate: PLATFORM_RATE,
      });
    } else {
      // Invalid (bot / duplicate / forged): record an unbilled click for
      // analytics, charge nobody.
      //
      // `tier` is written explicitly even though 'paid' is the column default,
      // because which bucket this row lands in is a decision, not a default.
      // Reporting counts billed clicks as `valid` and unbillable-but-real ones
      // as `not valid and tier = 'free'`; an invalid click is neither, and
      // moving it into the free bucket to make it visible would fold bot
      // traffic into delivery and inflate every CTR on the dashboard. It stays
      // out, and ad_slot_totals reports the count separately as invalid_clicks
      // so it is still visible somewhere.
      await sb.from("ad_clicks").insert({
        impression_id: input.impressionId ?? null,
        slot_id: input.slotId,
        campaign_id: campaign.id,
        creative_id: input.creativeId ?? null,
        visitor_id: visitorId,
        ip_hash: ipHash,
        geo_country: input.ctx?.country ?? null,
        device: input.ctx?.device ?? null,
        charged_cents: 0,
        publisher_earn_cents: 0,
        platform_cut_cents: 0,
        valid: false,
        tier: "paid",
      });
    }
  }

  // Always resolve the redirect, even if the click was unbilled.
  return appendRef(campaign.destination_url, campaign.ref_slug);
}
