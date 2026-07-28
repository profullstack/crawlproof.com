import { NextResponse } from "next/server";
import { requireProjectAccess } from "@/lib/lx/currentSite";
import { contactsForProject, toCsv } from "@/lib/outreach/contactsExport";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The organization's contact list, as CSV.
 *
 * Access-checked against the project like every other outreach surface; the
 * contacts themselves are org-scoped, which is deliberate — the same person
 * found by two projects is one contact, and the export reflects that rather
 * than the project that happened to request it.
 *
 * Viewers are allowed. Reading the list is not an outreach action, and a
 * read-only member being unable to look at it would make the export useless
 * to exactly the people most likely to want it as a file.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const access = await requireProjectAccess(id, { allowViewer: true });
  if (!access.ok) {
    return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  }

  const rows = await contactsForProject(id);
  const stamp = new Date().toISOString().slice(0, 10);

  // Leading BOM: without it Excel reads the file as the local codepage and
  // mangles every accented name in it.
  return new NextResponse(`﻿${toCsv(rows)}`, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="contacts-${stamp}.csv"`,
      "cache-control": "no-store",
    },
  });
}
