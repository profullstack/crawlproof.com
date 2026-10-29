import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import {
  LEAD_EXPORT_DESTINATION,
  LEAD_SUPPRESSION_DESTINATION,
  pushToOutreachGraph,
  readAll,
  selectExports,
  selectSuppressions,
  suppressInOutreachGraph,
  type ScanLead,
} from "@/lib/leadExport";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(req: Request) {
  return POST(req);
}

/**
 * Sends scan leads OutreachGraph has not had yet, and every unsubscribe as an
 * OutreachGraph suppression. Idempotent: lead_exports records both, so a tick
 * with nothing new does nothing and a failed push is retried on the next one.
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
  let audits: Array<{ pdf_email: string | null; target_url: string | null }>;
  let contacts: Array<{ email: string; unsubscribed_at: string | null; consented_at: string | null }>;
  let exported: Array<{ email: string; destination: string }>;
  try {
    // Whole tables, paged: both outgrow PostgREST's 1,000-row answer.
    [audits, contacts, exported] = await Promise.all([
      readAll<{ pdf_email: string | null; target_url: string | null }>((from, to) =>
        svc
          .from("audits")
          .select("pdf_email, target_url")
          .not("pdf_email", "is", null)
          .order("created_at", { ascending: false })
          .order("id", { ascending: true })
          .range(from, to),
      ),
      readAll<{ email: string; unsubscribed_at: string | null; consented_at: string | null }>((from, to) =>
        svc
          .from("marketing_contacts")
          .select("email, unsubscribed_at, consented_at")
          .order("email", { ascending: true })
          .range(from, to),
      ),
      readAll<{ email: string; destination: string }>((from, to) =>
        svc
          .from("lead_exports")
          .select("email, destination")
          .in("destination", [LEAD_EXPORT_DESTINATION, LEAD_SUPPRESSION_DESTINATION])
          .order("email", { ascending: true })
          .order("destination", { ascending: true })
          .range(from, to),
      ),
    ]);
  } catch (err) {
    return NextResponse.json({ ok: false, error: String((err as Error).message ?? err) }, { status: 500 });
  }
  const cMap = new Map(contacts.map((c) => [String(c.email).toLowerCase(), c]));
  const leads: ScanLead[] = audits.map((a) => {
    const email = String(a.pdf_email ?? "").trim().toLowerCase();
    const c = cMap.get(email);
    return {
      email,
      targetUrl: a.target_url ?? null,
      unsubscribedAt: c?.unsubscribed_at ?? null,
      consentedAt: c?.consented_at ?? null,
    };
  });
  const sent = (dest: string) =>
    new Set(exported.filter((r) => r.destination === dest).map((r) => String(r.email).toLowerCase()));
  const rows = selectExports(leads, sent(LEAD_EXPORT_DESTINATION));
  // Every opt-out, not only scan leads': an unsubscribe from us holds there too.
  const unsubscribed = selectSuppressions(
    contacts.map((c) => ({
      email: c.email,
      targetUrl: null,
      unsubscribedAt: c.unsubscribed_at,
      consentedAt: c.consented_at,
    })),
    sent(LEAD_SUPPRESSION_DESTINATION),
  );
  const og = { apiUrl: env.outreachgraphApiUrl, apiKey: env.outreachgraphApiKey };

  try {
    // Suppress first: an address that both opted out and is new must never
    // reach OutreachGraph unsuppressed, even if the import below fails.
    let suppressed = 0;
    if (unsubscribed.length > 0) {
      const suppressionId = await suppressInOutreachGraph(unsubscribed, og);
      const { error: supErr } = await svc.from("lead_exports").upsert(
        unsubscribed.map((email) => ({
          email,
          destination: LEAD_SUPPRESSION_DESTINATION,
          import_id: suppressionId,
        })),
        { onConflict: "email,destination" },
      );
      if (supErr) throw new Error(`recording suppressions failed: ${supErr.message}`);
      suppressed = unsubscribed.length;
    }
    if (rows.length === 0) return NextResponse.json({ ok: true, exported: 0, suppressed });

    const imports = await pushToOutreachGraph(rows, {
      ...og,
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
    return NextResponse.json({
      ok: true,
      exported: records.length,
      suppressed,
      imports: imports.map((i) => i.importId),
    });
  } catch (err) {
    console.error("[cron/lead-export]", err);
    return NextResponse.json({ ok: false, error: String((err as Error).message ?? err) }, { status: 502 });
  }
}
