import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ApiTokensClient } from "./client";

export const metadata = { title: "Social · API tokens" };

type TokenRow = {
  id: string;
  name: string;
  prefix: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
};

export default async function ApiTokensPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: projectId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: tokens } = await supabase
    .from("sp_api_token")
    .select("id, name, prefix, last_used_at, revoked_at, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <div>
        <Link
          href={`/projects/${projectId}/social/setup`}
          className="text-sm text-[var(--color-muted)]"
        >
          ← Social
        </Link>
        <h1 className="mt-4 text-3xl font-bold">API tokens</h1>
        <p className="mt-2 text-[var(--color-muted)]">
          Use these tokens to post via the Crawlproof social API from external
          tools — the <a
            href="https://github.com/profullstack/sh1pt"
            target="_blank"
            rel="noreferrer"
            className="underline"
          >sh1pt CLI</a> (<code>sh1pt promote</code>), your own scripts, CI
          jobs, etc. Each token grants the same posting power your logged-in
          session has on this account. Revoke any token at any time.
        </p>
        <p className="mt-2 text-xs text-[var(--color-muted)]">
          API base URL: <code>{`${process.env.NEXT_PUBLIC_SITE_URL ?? "https://crawlproof.com"}/api/sp/v1`}</code>
        </p>
      </div>

      <ApiTokensClient tokens={(tokens ?? []) as TokenRow[]} />
    </div>
  );
}
