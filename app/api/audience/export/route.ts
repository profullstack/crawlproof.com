// GET /api/audience/export[?consented=1]
// Session-authenticated CSV export of the caller's Audience Hub contacts.
// RLS does the scoping: the select policy returns contacts owned by the
// user plus contacts in orgs the user owns.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const COLUMNS = [
  "email",
  "name",
  "status",
  "marketing_consent",
  "unsubscribed_at",
  "suppressed_at",
  "first_seen_at",
  "last_seen_at",
  "first_utm_source",
  "first_utm_campaign",
  "last_utm_source",
  "last_utm_campaign",
  "first_url",
  "last_url",
  "tags",
] as const;

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = Array.isArray(value) ? value.join(";") : String(value);
  // Defang spreadsheet formula injection, then quote.
  const safe = /^[=+\-@\t]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const consentedOnly =
    new URL(request.url).searchParams.get("consented") === "1";

  const lines: string[] = [COLUMNS.join(",")];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    let q = supabase
      .from("audience_contacts")
      .select(COLUMNS.join(", "))
      .order("last_seen_at", { ascending: false })
      .range(from, from + pageSize - 1);
    if (consentedOnly) {
      // Marketing destinations only get opted-in, non-suppressed contacts.
      q = q
        .eq("marketing_consent", true)
        .is("unsubscribed_at", null)
        .is("suppressed_at", null);
    }
    const { data, error } = await q;
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    const rows = (data ?? []) as unknown as Record<string, unknown>[];
    for (const record of rows) {
      lines.push(COLUMNS.map((col) => csvCell(record[col])).join(","));
    }
    if (!data || data.length < pageSize) break;
  }

  const date = new Date().toISOString().slice(0, 10);
  return new NextResponse(lines.join("\n") + "\n", {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="crawlproof-audience-${date}${consentedOnly ? "-consented" : ""}.csv"`,
      "cache-control": "no-store",
    },
  });
}
