import type { Metadata } from "next";
import Link from "next/link";
import { MonitorPlans, MONITOR_PAYMENT_NOTE } from "@/components/monitor-plans";
import { serviceClient } from "@/lib/supabase/service";

export const metadata: Metadata = {
  title: "Weekly AI-visibility monitoring",
  description:
    "CrawlProof re-runs your AI-visibility audit every week and emails you when the score changes. Solo $49/month for one site, Agency $199/month for up to 20.",
  alternates: { canonical: "/monitor" },
};

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export default async function MonitorPage({
  searchParams,
}: {
  searchParams: Promise<{ site?: string }>;
}) {
  const sp = await searchParams;
  const token = typeof sp.site === "string" && /^[A-Za-z0-9_-]{6,64}$/.test(sp.site) ? sp.site : null;

  let host: string | null = null;
  if (token) {
    const { data } = await serviceClient()
      .from("audits")
      .select("target_url")
      .eq("share_token", token)
      .maybeSingle();
    host = data?.target_url ? hostOf(data.target_url as string) : null;
  }

  return (
    <main className="mx-auto max-w-4xl px-4 py-12 sm:px-6 sm:py-16">
      <p className="text-sm font-medium uppercase tracking-wider text-[var(--color-accent)]">
        Weekly monitoring
      </p>
      <h1 className="mt-2 text-balance text-3xl font-extrabold sm:text-4xl">
        {host ? `Watch ${host} every week` : "Know when your AI visibility changes"}
      </h1>
      <p className="mt-4 max-w-2xl text-lg text-[var(--color-muted)]">
        A site update, a new robots.txt rule or a broken schema block can hide a site from
        ChatGPT, Claude and Perplexity without anyone noticing. CrawlProof re-runs the audit
        every week and emails you the moment the score moves, with the report showing what changed.
      </p>

      <div className="mt-10">
        <MonitorPlans token={token} />
      </div>
      <p className="mt-4 text-sm text-[var(--color-muted)]">{MONITOR_PAYMENT_NOTE}</p>

      <div className="mt-12 card p-6">
        <h2 className="text-lg font-bold">Not ready to pay?</h2>
        <p className="mt-2 text-[var(--color-muted)]">
          The audit itself is free and needs no account.{" "}
          <Link href="/#audit" className="font-semibold text-[var(--color-accent)] hover:underline">
            Run a free audit
          </Link>
          .
        </p>
      </div>
    </main>
  );
}
