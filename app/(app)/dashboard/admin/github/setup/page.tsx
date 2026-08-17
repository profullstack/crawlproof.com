// Admin-only: register CrawlProof as a GitHub App on the profullstack
// org via the App Manifest flow. Lives under /admin because it's a
// one-time org-level setup, not a per-user action. Individual users
// go to /settings/integrations/github to *install* the App on their own
// account; this page is for the platform owner to *create* the App.

import { notFound } from "next/navigation";
import { headers } from "next/headers";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";

export const metadata = {
  title: "Admin · Register GitHub App",
  robots: { index: false, follow: false },
};

const ORG = "profullstack";

interface ManifestPermissions {
  contents: "read" | "write";
  pull_requests: "read" | "write";
  metadata: "read";
}

/**
 * Derive the public base URL from the actual request, falling back to
 * env.siteUrl. Protects against a misconfigured NEXT_PUBLIC_SITE_URL
 * baking a broken host (e.g. 0.0.0.0:8080) into the manifest — which
 * would route GitHub's conversion callback to a URL the admin can't
 * reach, locking the App's secrets behind an unreachable redirect.
 */
async function publicBaseUrl(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "https";
  if (host && !host.startsWith("0.0.0.0") && !host.startsWith("127.0.0.1")) {
    return `${proto}://${host}`.replace(/\/$/, "");
  }
  return env.siteUrl.replace(/\/$/, "");
}

function buildManifest(base: string) {
  return {
    name: "CrawlProof",
    url: base,
    hook_attributes: { url: `${base}/api/github/webhook`, active: false },
    redirect_url: `${base}/api/github/setup-callback`,
    callback_urls: [`${base}/api/github/callback`],
    setup_url: `${base}/api/github/callback`,
    setup_on_update: true,
    public: false,
    default_permissions: {
      contents: "write",
      pull_requests: "write",
      metadata: "read",
    } as ManifestPermissions,
    default_events: [],
    description:
      "CrawlProof — opens automated PRs to install our stats.js tracker and apply AEO audit fixes.",
  };
}

export default async function AdminGithubSetupPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) notFound();
  const { data: me } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("id", user.id)
    .maybeSingle();
  if (!me?.is_admin) notFound();

  const { error } = await searchParams;
  const base = await publicBaseUrl();
  const manifest = buildManifest(base);
  const action = `https://github.com/organizations/${ORG}/settings/apps/new?state=${encodeURIComponent("crawlproof-setup")}`;

  return (
    <main className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <p className="text-sm">
        <Link href="/dashboard/admin" className="text-[var(--color-muted)] hover:underline">
          ← Admin
        </Link>
      </p>
      <h1 className="mt-2 text-3xl font-extrabold">
        Register CrawlProof as a GitHub App
      </h1>
      <p className="mt-3 text-[var(--color-muted)]">
        One-time platform setup. Click <strong>Create GitHub App</strong>{" "}
        below, sign in to the <code>{ORG}</code> org on GitHub if prompted,
        and confirm. GitHub redirects back here with the App&apos;s
        secrets — copy them into Railway and the integration is live for
        every CrawlProof user.
      </p>

      {error && (
        <div className="mt-6 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <section className="mt-8 card p-5">
        <h2 className="text-lg font-semibold">What gets created</h2>
        <ul className="mt-3 list-disc pl-5 text-sm leading-relaxed">
          <li>
            App name <code>CrawlProof</code>, owned by{" "}
            <code>{ORG}</code>, private (not listed on the GitHub
            marketplace).
          </li>
          <li>
            Permissions: <code>Contents: write</code>,{" "}
            <code>Pull requests: write</code>, <code>Metadata: read</code>.
            Just enough to push a branch and open a PR.
          </li>
          <li>No webhook events subscribed; webhook url is set but inactive.</li>
          <li>
            Callback URLs derived from this request&apos;s host:{" "}
            <code className="font-mono">{base}/api/github/callback</code>,{" "}
            <code className="font-mono">{base}/api/github/setup-callback</code>.
          </li>
        </ul>
      </section>

      <form action={action} method="POST" className="mt-6">
        <input type="hidden" name="manifest" value={JSON.stringify(manifest)} />
        <button type="submit" className="btn btn-primary">
          Create GitHub App for {ORG} →
        </button>
      </form>

      <p className="mt-6 text-xs text-[var(--color-muted)]">
        Note: GitHub does not expose App creation via REST or the gh CLI.
        This manifest flow is the supported one-click alternative.
      </p>
    </main>
  );
}
