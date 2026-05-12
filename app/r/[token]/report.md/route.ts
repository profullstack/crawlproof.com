import { serviceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const svc = serviceClient();
  const { data } = await svc.rpc("get_public_audit", { token });
  const audit = (data as Array<{ report_markdown: string | null }> | null)?.[0];
  if (!audit) return new Response("Not found", { status: 404 });
  const md = audit.report_markdown;
  if (!md) return new Response("Report not ready yet.", { status: 425 });
  return new Response(md, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
