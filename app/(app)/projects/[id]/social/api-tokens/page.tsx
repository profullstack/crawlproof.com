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

      <McpServerSection />
    </div>
  );
}

function McpServerSection() {
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "https://crawlproof.com";
  const mcpUrl = `${site}/api/mcp`;
  const agentConfig = `{
  "mcpServers": {
    "crawlproof": {
      "url": "${mcpUrl}",
      "headers": { "Authorization": "Bearer crp_YOUR_TOKEN" }
    }
  }
}`;
  // Note the Accept header — the Streamable-HTTP transport requires both types.
  const curlList = `curl -s ${mcpUrl} \\
  -H "Authorization: Bearer $CRAWLPROOF_MCP_TOKEN" \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/json, text/event-stream" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`;
  const curlPromote = `curl -s ${mcpUrl} \\
  -H "Authorization: Bearer $CRAWLPROOF_MCP_TOKEN" \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/json, text/event-stream" \\
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{
        "name":"promote_url","arguments":{"url":"https://example.com"}}}'`;

  return (
    <section className="card space-y-4 p-5">
      <div>
        <h2 className="text-lg font-semibold">MCP server</h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          The same token also authenticates the CrawlProof{" "}
          <a href="https://modelcontextprotocol.io" target="_blank" rel="noreferrer" className="underline">
            MCP
          </a>{" "}
          server, so an AI agent can write and publish promo posts to your socials. Endpoint:{" "}
          <code>{mcpUrl}</code>
        </p>
      </div>

      <div>
        <div className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          Add to your agent (Claude Desktop, Cursor, …)
        </div>
        <pre className="mt-1 overflow-x-auto rounded border border-[var(--color-border)] bg-[var(--color-bg-deep)] p-3 text-xs">
          {agentConfig}
        </pre>
      </div>

      <div>
        <div className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          List the tools (curl)
        </div>
        <pre className="mt-1 overflow-x-auto rounded border border-[var(--color-border)] bg-[var(--color-bg-deep)] p-3 text-xs">
          {curlList}
        </pre>
      </div>

      <div>
        <div className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
          Write &amp; post in one call (curl)
        </div>
        <pre className="mt-1 overflow-x-auto rounded border border-[var(--color-border)] bg-[var(--color-bg-deep)] p-3 text-xs">
          {curlPromote}
        </pre>
      </div>

      <p className="text-xs text-[var(--color-muted)]">
        Set <code>CRAWLPROOF_MCP_TOKEN</code> to a token above. Tools:{" "}
        <code>list_accounts</code>, <code>generate_promo_post</code>, <code>post_to_socials</code>,{" "}
        <code>promote_url</code>. The <code>Accept: application/json, text/event-stream</code> header
        is required. Cookie-auth platforms report <code>queued</code> — the post lands shortly after.
      </p>
    </section>
  );
}
