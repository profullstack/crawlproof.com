// Public application intake for the careers widget.
// POST /api/careers/apply  { site, job, fullName, email, link, note? }
//
// Three fields and a link — no file upload, so we never take custody of a
// resume. Writes with the service role because applicants have no session.
//
// Being unauthenticated and on the open internet, this endpoint carries two
// spam defences. The (job_id, email) unique constraint only stops an honest
// double-submit; a script that varies the address walks straight past it.
//   1. A honeypot field the widget renders hidden. Humans never fill it.
//   2. A per-source hourly cap, counted off a salted hash of the client IP.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { serviceClient } from "@/lib/supabase/service";
import { isValidEmail, normalizeLink } from "@/lib/careers/jobs";
import { notifyNewApplication } from "@/lib/careers/notify";
import { clientIpFromHeaders } from "@/lib/tracker/geo";
import { hashIp } from "@/lib/rateLimit";

export const runtime = "nodejs";

// Applications allowed from one source per hour. A real person applying to
// several roles at one company stays well under it; a scripted flood does not.
export const APPLY_HOURLY_CAP = 8;

const bodySchema = z.object({
  site: z.string().uuid(),
  job: z.string().uuid(),
  fullName: z.string().min(1).max(200),
  email: z.string().min(3).max(254),
  link: z.string().max(500).nullable().optional(),
  note: z.string().max(2000).nullable().optional(),
  url: z.string().max(2048).nullable().optional(),
  // Honeypot. Named to look worth filling in to a bot scanning field names.
  company: z.string().max(200).nullable().optional(),
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

  // Honeypot tripped: answer exactly as we would on success, so whatever is
  // filling it gets no signal to adapt. Nothing is written.
  if (body.company && body.company.trim()) {
    return NextResponse.json({ ok: true }, { headers: corsHeaders(request) });
  }

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
  const ipHash = hashIp(clientIpFromHeaders(request.headers));

  // Per-source hourly cap. Counted before the posting lookup so a flood costs
  // one indexed count() rather than the full write path.
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count } = await supabase
    .from("job_applications")
    .select("id", { count: "exact", head: true })
    .eq("ip_hash", ipHash)
    .gte("created_at", since);
  if ((count ?? 0) >= APPLY_HOURLY_CAP) {
    return fail(request, "Too many applications from here. Try again later.", 429);
  }

  // The posting must be open and belong to a project with the module on —
  // otherwise a stale widget could keep posting to a closed role.
  const [{ data: job }, { data: project }] = await Promise.all([
    supabase
      .from("job_postings")
      .select("id, status, title")
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
      ip_hash: ipHash,
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

  // The applicant is done either way — a mail failure must not surface to them
  // as a failed application, so this is awaited but never throws.
  await notifyNewApplication({
    projectId: body.site,
    jobTitle: (job as { title?: string }).title ?? "a role",
    fullName,
    email,
    link,
  });

  return NextResponse.json({ ok: true }, { headers: corsHeaders(request) });
}
