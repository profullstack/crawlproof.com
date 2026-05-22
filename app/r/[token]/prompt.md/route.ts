import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { loadConsolidatedOrSoloMarkdown } from "@/lib/audit/summary-markdown";

export const dynamic = "force-dynamic";

// Serves the share-token's report as Markdown. For multi-engine scan runs
// (≥ 2 audits sharing the same scan_run_id) the response is a consolidated
// document — executive summary + each engine's full report — designed for
// pasting into another LLM. Solo runs return the single audit's markdown.
//
// Gated to signed-in users. The structured /r/<token> page stays public so
// you can share the report itself, but the LLM-ready Markdown prompt is a
// registered-account feature.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const session = await createClient();
  const {
    data: { user },
  } = await session.auth.getUser();
  if (!user) {
    return new Response(
      `Sign in to download the LLM-ready Markdown prompt.\n\nThe public report at /r/${token} stays visible to anyone with the link; the prompt download is for registered users.\n`,
      {
        status: 401,
        headers: { "content-type": "text/plain; charset=utf-8" },
      },
    );
  }

  const svc = serviceClient();

  // Look up the audit by share_token. We need the scan_run_id and
  // target_url to decide whether to stitch siblings into one document.
  const { data: own } = await svc
    .from("audits")
    .select("id, scan_run_id, target_url, report_markdown, status")
    .eq("share_token", token)
    .maybeSingle();
  if (!own) return new Response("Not found", { status: 404 });
  if (own.status !== "complete" || !own.report_markdown) {
    return new Response("Report not ready yet.", { status: 425 });
  }

  // Shared with the on-page Report tab so what you see equals what you
  // grab — multi-engine runs return the consolidated doc, solo runs
  // return just this audit's markdown.
  const md =
    (await loadConsolidatedOrSoloMarkdown(svc, {
      scan_run_id: own.scan_run_id,
      target_url: own.target_url,
      report_markdown: own.report_markdown,
    })) ?? own.report_markdown;
  return new Response(md, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
