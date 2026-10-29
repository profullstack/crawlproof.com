import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import {
  LEAD_EXPORT_DESTINATION,
  pushToOutreachGraph,
  selectExports,
  type ScanLead,
} from "@/lib/leadExport";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(req: Request) {
  return POST(req);
}

/**
 * Sends scan leads OutreachGraph has not had yet. Idempotent: lead_exports
 * records every address sent, so a tick with nothing new does nothing and a
 * failed push is retried on the next one.
 */
export async function POST(req: Request) {
  const incoming =
    req.headers.get("x-cron-secret") ??
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (incoming !== env.cronSecret) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!env.outreachgraphApiKey) {
    return NextResponse.json({ ok: true, skipped: "OUTREACHGRAPH_API_KEY is not set" });
  }

  const svc = serviceClient();
  const { data: audits, error } = await svc
    .from("audits")
    .select("pdf_email, target_url, created_at")
    .not("pdf_email", "is", null)
    .order("created_at", { ascending: false })
    .limit(5000);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const emails = Array.from(
    new Set((audits ?? []).map((a) => String(a.pdf_email ?? "").trim().toLowerCase()).filter(Boolean)),
  );
  if (emails.length === 0) return NextResponse.json({ ok: true, exported: 0 });

  const [{ data: contacts }, { data: exported }] = await Promise.all([
    svc.from("marketing_contacts").select("email, unsubscribed_at, consented_at").in("email", emails),
    svc.from("lead_exports").select("email").eq("destination", LEAD_EXPORT_DESTINATION),
  ]);
  const cMap = new Map(
    (contacts ?? []).map((c) => [String(c.email).toLowerCase(), c as Record<string, unknown>]),
  );
  const leads: ScanLead[] = (audits ?? []).map((a) => {
    const email = String(a.pdf_email ?? "").trim().toLowerCase();
    const c = cMap.get(email);
    return {
      email,
      targetUrl: (a.target_url as string | null) ?? null,
      unsubscribedAt: (c?.unsubscribed_at as string | null) ?? null,
      consentedAt: (c?.consented_at as string | null) ?? null,
    };
  });
  const done = new Set((exported ?? []).map((r) => String(r.email).toLowerCase()));
  const rows = selectExports(leads, done);
  if (rows.length === 0) return NextResponse.json({ ok: true, exported: 0 });

  try {
    const imports = await pushToOutreachGraph(rows, {
      apiUrl: env.outreachgraphApiUrl,
      apiKey: env.outreachgraphApiKey,
    });
    const byEmail = new Map(rows.map((r) => [r.email, r]));
    const records = imports.flatMap((imp) =>
      imp.emails.map((email) => ({
        email,
        destination: LEAD_EXPORT_DESTINATION,
        company_domain: byEmail.get(email)?.companyDomain ?? null,
        import_id: imp.importId,
      })),
    );
    const { error: recErr } = await svc.from("lead_exports").upsert(records, { onConflict: "email,destination" });
    if (recErr) throw new Error(`recording exports failed: ${recErr.message}`);
    return NextResponse.json({ ok: true, exported: records.length, imports: imports.map((i) => i.importId) });
  } catch (err) {
    console.error("[cron/lead-export]", err);
    return NextResponse.json({ ok: false, error: String((err as Error).message ?? err) }, { status: 502 });
  }
}
