import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { AUTHORIZE_FIELDS, checkAuthorize, type AuthorizeParams } from "@/lib/mcp-oauth";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Connect an app",
  description: "Allow an AI app (ChatGPT, Claude, …) to use your CrawlProof account through the CrawlProof MCP server.",
  robots: { index: false, follow: false },
};

/**
 * The OAuth 2.1 authorization endpoint for the MCP server at /api/mcp.
 * Validates the request (unknown client or redirect is shown here, never
 * followed), sends a signed-out visitor through /login and back, then asks the
 * signed-in user to allow or deny. The form posts to /api/oauth/authorize.
 */
export default async function OAuthAuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const p: AuthorizeParams = {};
  for (const k of AUTHORIZE_FIELDS) {
    const v = sp[k];
    if (typeof v === "string") (p as Record<string, unknown>)[k] = v;
  }

  const check = await checkAuthorize(serviceClient(), p);
  if (!check.ok) {
    if ("redirect" in check) redirect(check.redirect);
    return (
      <main className="mx-auto max-w-md px-4 py-12 sm:px-6 sm:py-16">
        <h1 className="text-2xl font-bold">This connection request is not valid</h1>
        <p className="mt-4 rounded-md border border-[rgba(248,113,113,0.4)] bg-[rgba(248,113,113,0.08)] p-3 text-sm text-[var(--color-fail)]">
          {check.description}
        </p>
        <p className="mt-6 text-sm text-[var(--color-muted)]">
          Go back to the app you came from and connect CrawlProof again.
        </p>
      </main>
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    const qs = new URLSearchParams(p as Record<string, string>).toString();
    redirect(`/login?redirect=${encodeURIComponent(`/oauth/authorize?${qs}`)}`);
  }

  const redirectHost = new URL(check.redirectUri).host;
  return (
    <main className="mx-auto max-w-md px-4 py-12 sm:px-6 sm:py-16">
      <h1 className="text-2xl font-bold">
        Allow <span className="break-words">{check.client.client_name}</span> to use your CrawlProof account?
      </h1>
      <p className="mt-3 text-[var(--color-muted)]">
        Signed in as <strong>{user.email ?? "your account"}</strong>.
      </p>
      <ul className="mt-6 list-disc space-y-2 pl-5 text-sm">
        <li>It can use every CrawlProof MCP tool as you: projects, audits, stats, promote, leads, webhooks and credits.</li>
        <li>You will be sent back to <strong>{redirectHost}</strong>.</li>
        <li>Access lasts until you disconnect it; tokens expire hourly and are refreshed.</li>
      </ul>
      {check.client.client_uri && (
        <p className="mt-4 text-xs text-[var(--color-muted)]">App site: {check.client.client_uri}</p>
      )}
      <form method="post" action="/api/oauth/authorize" className="mt-8 flex gap-3">
        {AUTHORIZE_FIELDS.map((k) => {
          const v = (p as Record<string, unknown>)[k];
          return typeof v === "string" ? <input key={k} type="hidden" name={k} value={v} /> : null;
        })}
        <button type="submit" name="decision" value="deny" className="btn flex-1">
          Deny
        </button>
        <button type="submit" name="decision" value="allow" className="btn btn-primary flex-1">
          Allow
        </button>
      </form>
    </main>
  );
}
