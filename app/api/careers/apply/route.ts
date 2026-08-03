// Public application intake for the careers widget.
// POST /api/careers/apply  { site, job, fullName, email, link, note? }
//
// Three fields and a link — no file upload, so we never take custody of a
// resume. Writes with the service role because applicants have no session.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { serviceClient } from "@/lib/supabase/service";
import { isValidEmail, normalizeLink } from "@/lib/careers/jobs";

export const runtime = "nodejs";

const bodySchema = z.object({
  site: z.string().uuid(),
  job: z.string().uuid(),
  fullName: z.string().min(1).max(200),
  email: z.string().min(3).max(254),
  link: z.string().max(500).nullable().optional(),
  note: z.string().max(2000).nullable().optional(),
  url: z.string().max(2048).nullable().optional(),
});

function corsHeaders(request: Request) {
  const origin = request.headers.get("origin");
  const headers: Record<string, string> = {
    "access-control-allow-origin": origin ?? "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers":
      request.headers.get("access-control-request-headers") ?? "content-type",
    "access-control-max-age": "86400",
    "cache-control": "no-store",
    vary: "Origin",
  };
  return headers;
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

function fail(request: Request, error: string, status = 400) {
  return NextResponse.json({ ok: false, error }, { status, headers: corsHeaders(request) });
}

export async function POST(request: NextRequest) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail(request, "Invalid request.");
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return fail(request, "Check the form and try again.");
  const body = parsed.data;

  const fullName = body.fullName.trim().replace(/\s+/g, " ");
  const email = body.email.trim().toLowerCase();
  if (!fullName) return fail(request, "Enter your name.");
  if (!isValidEmail(email)) return fail(request, "Enter a valid email address.");

  // A link is optional in the schema but required in spirit — if one is given
  // it must be a real http(s) URL, since the dashboard renders it as a link.
  let link: string | null = null;
  if (body.link && body.link.trim()) {
    link = normalizeLink(body.link);
    if (!link) return fail(request, "Enter a valid portfolio, LinkedIn, or GitHub URL.");
  }

  const supabase = serviceClient();

  // The posting must be open and belong to a project with the module on —
  // otherwise a stale widget could keep posting to a closed role.
  const [{ data: job }, { data: project }] = await Promise.all([
    supabase
      .from("job_postings")
      .select("id, status")
      .eq("id", body.job)
      .eq("project_id", body.site)
      .maybeSingle(),
    supabase
      .from("projects")
      .select("careers_enabled, tracker_enabled")
      .eq("id", body.site)
      .maybeSingle(),
  ]);

  if (
    !job ||
    job.status !== "open" ||
    !project?.careers_enabled ||
    !project?.tracker_enabled
  ) {
    return fail(request, "This role is no longer accepting applications.", 410);
  }

  const { error } = await supabase.from("job_applications").upsert(
    {
      project_id: body.site,
      job_id: body.job,
      full_name: fullName.slice(0, 200),
      email,
      link,
      note: body.note?.trim().slice(0, 2000) || null,
      source_url: body.url?.slice(0, 2048) ?? null,
      referrer: request.headers.get("referer")?.slice(0, 2048) ?? null,
      user_agent: request.headers.get("user-agent")?.slice(0, 500) ?? null,
      updated_at: new Date().toISOString(),
    },
    // Re-submitting the same email for the same role updates that row instead
    // of filling the inbox with duplicates.
    { onConflict: "job_id,email" },
  );

  if (error) {
    return fail(request, "Could not submit right now. Try again shortly.", 500);
  }

  return NextResponse.json({ ok: true }, { headers: corsHeaders(request) });
}
