// Account-level GitHub integration page (user POV — install + manage your
// own GitHub installations). Three states:
//   1. Env not configured        → "integration not available yet" notice.
//                                  Admins see a small inline link to /admin.
//   2. Configured, not connected → "Install" CTA pointing at github.com/apps/<slug>.
//   3. Connected                 → list of installations + their repos with a
//                                  client-side filter (sized for 200+).
//
// Platform-level App registration is NOT here. It lives at /admin/github/setup.

import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { env } from "@/lib/env";
import {
  listInstallationRepos,
  type GhRepo,
} from "@/lib/github/app";
import { getOrMintInstallationToken } from "@/lib/github/installations";
import { ReposFilter } from "./repos-filter";

export const metadata = {
  title: "GitHub integration",
};

interface InstallationRow {
  installation_id: number;
  account_login: string;
  account_type: "User" | "Organization";
  suspended_at: string | null;
}

interface InstallationView {
  installation_id: number;
  account_login: string;
  account_type: "User" | "Organization";
  suspended_at: string | null;
  repos?: GhRepo[];
  loadError?: string;
}

export default async function GithubSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{
    connected?: string;
    error?: string;
    notice?: string;
  }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?redirect=/settings/integrations/github");

  const { data: profile } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("id", user.id)
    .maybeSingle();
  const isAdmin = !!profile?.is_admin;

  const { connected, error, notice } = await searchParams;

  const configured = !!(env.githubAppId && env.githubAppPrivateKey);
  const installUrl = env.githubAppSlug
    ? `https://github.com/apps/${env.githubAppSlug}/installations/new`
    : null;

  // Load installations for this user (RLS-scoped via auth client).
  const { data: rows } = await supabase
    .from("github_installations")
    .select("installation_id, account_login, account_type, suspended_at")
    .is("removed_at", null)
    .order("account_login", { ascending: true });
  const installations: InstallationView[] = (rows ?? []) as InstallationRow[];

  // For each installation, pull the live repo list. Use the service
  // client for token caching writes; safe because we already verified
  // the rows belong to this user via the auth-scoped read above.
  if (configured && installations.length > 0) {
    void serviceClient(); // ensure init
    await Promise.all(
      installations.map(async (inst) => {
        if (inst.suspended_at) return;
        try {
          const token = await getOrMintInstallationToken(
            inst.installation_id,
          );
          inst.repos = await listInstallationRepos(token);
        } catch (err) {
          inst.loadError = err instanceof Error ? err.message : "unknown";
        }
      }),
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <h1 className="text-3xl font-extrabold">GitHub</h1>
      <p className="mt-2 text-[var(--color-muted)]">
        Connect a GitHub installation and CrawlProof can open automated
        pull requests on your repos — installing the{" "}
        <Link href="/docs/stats-tracker" className="underline">
          stats tracker
        </Link>
        , applying fixes from your{" "}
        <Link href="/docs/aeo-score" className="underline">
          AEO Score audits
        </Link>
        .
      </p>

      {connected === "1" && (
        <div className="mt-6 rounded-md border border-green-500/40 bg-green-500/10 p-3 text-sm">
          GitHub installation connected.
        </div>
      )}
      {notice === "install_requested" && (
        <div className="mt-6 rounded-md border border-yellow-500/40 bg-yellow-500/10 p-3 text-sm">
          Install requested. The repo admin will need to approve it on
          GitHub before it shows up here.
        </div>
      )}
      {error && (
        <div className="mt-6 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {!configured ? (
        <section className="card mt-8 p-5">
          <h2 className="text-lg font-semibold">
            Integration not available yet
          </h2>
          <p className="mt-2 text-sm text-[var(--color-muted)]">
            The CrawlProof GitHub App isn&apos;t configured on this deployment.
            Check back soon.
          </p>
          {isAdmin && (
            <p className="mt-3 text-xs text-[var(--color-muted)]">
              Admin:{" "}
              <Link href="/admin/github/setup" className="underline">
                register the App at /admin/github/setup
              </Link>
              .
            </p>
          )}
        </section>
      ) : installations.length === 0 ? (
        <section className="card mt-8 p-5">
          <h2 className="text-lg font-semibold">No installations yet</h2>
          <p className="mt-2 text-sm text-[var(--color-muted)]">
            Install the CrawlProof GitHub App on your account or org and
            pick the repos you want to expose. You can install on multiple
            accounts; each one shows up below.
          </p>
          {installUrl && (
            <a
              href={installUrl}
              target="_blank"
              rel="noreferrer"
              className="btn btn-primary mt-4 inline-flex"
            >
              Install on GitHub →
            </a>
          )}
        </section>
      ) : (
        <div className="mt-8 space-y-6">
          {installations.map((inst) => (
            <section key={inst.installation_id} className="card p-5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <h2 className="text-lg font-semibold">
                    {inst.account_login}
                    <span className="ml-2 text-xs font-normal text-[var(--color-muted)]">
                      {inst.account_type}
                    </span>
                  </h2>
                </div>
                <div className="flex items-center gap-3 text-sm">
                  {installUrl && (
                    <a
                      href={installUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="underline text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
                    >
                      Add / remove repos →
                    </a>
                  )}
                </div>
              </div>
              {inst.suspended_at ? (
                <p className="mt-3 text-sm text-yellow-600">
                  Installation suspended on GitHub.
                </p>
              ) : inst.loadError ? (
                <p className="mt-3 text-sm text-red-600">
                  Failed to load repos: {inst.loadError}
                </p>
              ) : (
                <div className="mt-4">
                  <ReposFilter repos={inst.repos ?? []} />
                </div>
              )}
            </section>
          ))}
          {installUrl && (
            <p className="text-sm text-[var(--color-muted)]">
              Need to add a different account or org?{" "}
              <a
                className="underline"
                href={installUrl}
                target="_blank"
                rel="noreferrer"
              >
                Install on another account →
              </a>
            </p>
          )}
        </div>
      )}
    </main>
  );
}
