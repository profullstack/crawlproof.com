import { serviceClient } from "@/lib/supabase/service";
import { verifyUnsubscribeToken } from "@/lib/alerts/tokens";
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
    <a href="${env.siteUrl}/alerts" style="display:inline-block;margin-top:16px;padding:9px 16px;background:#1f2630;color:#e7e9ee;border-radius:8px;font-weight:700;text-decoration:none;">Manage alerts</a>
  </div>
</body>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

// Global unsubscribe: pauses ALL of the owner's active alerts. We pause rather
// than delete so seen-URL history survives and the user can resume later
// without a flood of old results. Supports one-click POST (RFC 8058) too.
async function unsubscribe(ownerId: string, token: string): Promise<Response> {
  if (!ownerId || !token || !verifyUnsubscribeToken(ownerId, token)) {
    return page("Invalid link", "This unsubscribe link is invalid or has expired.");
  }
  const svc = serviceClient();
  const { error } = await svc
    .from("alerts")
    .update({ status: "paused" })
    .eq("owner_id", ownerId)
    .eq("status", "active");
  if (error) return page("Something went wrong", "Please try again from your dashboard.");
  return page("Unsubscribed", "All your alerts are paused. Resume any of them any time — nothing was deleted.");
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  return unsubscribe(url.searchParams.get("owner") ?? "", url.searchParams.get("token") ?? "");
}

export async function POST(request: Request) {
  const url = new URL(request.url);
  return unsubscribe(url.searchParams.get("owner") ?? "", url.searchParams.get("token") ?? "");
}
