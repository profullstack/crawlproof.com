import { serviceClient } from "@/lib/supabase/service";
import { verifyPauseToken } from "@/lib/alerts/tokens";
import { env } from "@/lib/env";

export const runtime = "nodejs";

function page(title: string, body: string): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;background:#0b0d10;color:#e7e9ee;display:flex;min-height:100vh;align-items:center;justify-content:center;">
  <div style="max-width:420px;padding:32px;text-align:center;">
    <div style="font-weight:700;font-size:18px;margin-bottom:10px;">${title}</div>
    <p style="color:#94a3b8;line-height:1.6;">${body}</p>
    <a href="${env.siteUrl}/alerts" style="display:inline-block;margin-top:16px;padding:9px 16px;background:#6ee7b7;color:#042f1a;border-radius:8px;font-weight:700;text-decoration:none;">Manage alerts</a>
  </div>
</body>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

// One-click pause link from an alert email. Pausing keeps the alert's seen-URL
// history so resuming never re-surfaces old results.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const alertId = url.searchParams.get("alert") ?? "";
  const token = url.searchParams.get("token") ?? "";
  if (!alertId || !token || !verifyPauseToken(alertId, token)) {
    return page("Invalid link", "This pause link is invalid or has expired.");
  }
  const svc = serviceClient();
  const { data, error } = await svc
    .from("alerts")
    .update({ status: "paused" })
    .eq("id", alertId)
    .select("label")
    .maybeSingle();
  if (error || !data) {
    return page("Couldn't pause", "We couldn't find that alert — it may already be deleted.");
  }
  return page("Alert paused", `“${data.label}” is paused. Its history is kept, so resuming won't repeat old results.`);
}
