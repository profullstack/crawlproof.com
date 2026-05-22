// One-click GitHub App setup. Posts a pre-filled manifest to GitHub
// targeting the /profullstack org. After the admin clicks "Create", GitHub
// redirects to /api/github/setup-callback which exchanges the code and
// hands us back the App's secrets (id, slug, client_id/secret, webhook
// secret, PEM private key) to paste into Railway.
//
// Restricted to profiles.is_admin so random signed-in users can't kick
// off a registration on the org's behalf.

import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";

const ORG = "profullstack";

interface ManifestPermissions {
  contents: "read" | "write";
  pull_requests: "read" | "write";
  metadata: "read";
}

function buildManifest() {
  const base = env.siteUrl.replace(/\/$/, "");
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

export default async function GithubAppSetupPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?redirect=/settings/integrations/github/setup");

  const { data: profile } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile?.is_admin) {
    redirect("/settings/integrations/github?error=setup_admin_only");
  }

  const { error } = await searchParams;
  const manifest = buildManifest();
  const action = `https://github.com/organizations/${ORG}/settings/apps/new?state=${encodeURIComponent("crawlproof-setup")}`;

  return (
    <main className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <p className="text-sm">
        <Link
          href="/settings/integrations/github"
          className="text-[var(--color-muted)] hover:underline"
        >
          ← GitHub settings
        </Link>
      </p>
      <h1 className="mt-2 text-3xl font-extrabold">
        Register CrawlProof as a GitHub App
      </h1>
      <p className="mt-3 text-[var(--color-muted)]">
        One click for the org admin. Click <strong>Create GitHub App</strong>{" "}
        below, sign in to the <code>{ORG}</code> org on GitHub if prompted,
        and confirm. GitHub will redirect you back here with the App&apos;s
        secrets — copy them into Railway and the integration is live.
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
            Callback URLs:{" "}
            <code className="font-mono">
              {env.siteUrl}/api/github/callback
            </code>
            ,{" "}
            <code className="font-mono">
              {env.siteUrl}/api/github/setup-callback
            </code>
            .
          </li>
        </ul>
      </section>

      <form action={action} method="POST" className="mt-6">
        <input
          type="hidden"
          name="manifest"
          value={JSON.stringify(manifest)}
        />
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
