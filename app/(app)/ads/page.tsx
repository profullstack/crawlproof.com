import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { CampaignActions } from "@/components/ads/campaign-actions";

export const metadata = { title: "Ad campaigns" };

type CampaignRow = {
  id: string;
  ref_slug: string;
  name: string;
  destination_domain: string | null;
  daily_budget_cents: number;
  status: string;
  created_at: string;
};

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export default async function AdsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let campaigns: CampaignRow[] = [];
  if (user) {
    const { data } = await supabase
      .from("ad_campaigns")
      .select("id, ref_slug, name, destination_domain, daily_budget_cents, status, created_at")
      .order("created_at", { ascending: false });
    campaigns = (data as CampaignRow[]) ?? [];
  }

  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Ad campaigns</h1>
        <div className="flex items-center gap-2">
          <Link href="/ads/slots" className="btn">
            Monetize a site
          </Link>
          <Link href="/ads/new" className="btn btn-primary">
            Create an ad
          </Link>
        </div>
      </div>
      <p className="mt-2 text-[var(--color-muted)]">
        Promote your site across the CrawlProof network. Give a URL, we design the ads,
        you fund a daily budget — publishers earn crypto for the clicks.
      </p>

      {campaigns.length === 0 ? (
        <div className="card mt-6 p-8 text-center text-[var(--color-muted)]">
          No campaigns yet.{" "}
          <Link href="/ads/new" className="text-[var(--color-accent)]">
            Create your first ad
          </Link>
          .
        </div>
      ) : (
        <ul className="mt-6 space-y-2">
          {campaigns.map((c) => (
            <li key={c.id} className="card flex items-center justify-between gap-4 p-4">
              <div className="min-w-0">
                <div className="truncate font-semibold">{c.name}</div>
                <div className="truncate text-sm text-[var(--color-muted)]">
                  {c.destination_domain} · {dollars(c.daily_budget_cents)}/day ·{" "}
                  <span className="font-mono">{c.ref_slug}</span>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className="badge whitespace-nowrap">{c.status}</span>
                <CampaignActions id={c.id} status={c.status} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
