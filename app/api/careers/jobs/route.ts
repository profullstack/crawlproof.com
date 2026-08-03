// Public jobs feed for the careers widget (/careers.js) and the hosted board.
// GET /api/careers/jobs?site=<project_id>
//
// Returns only roles the project has published, and only while the module is
// switched on. Unknown or disabled projects get an empty list rather than a
// 404 so the widget's failure mode is "no jobs" — never a broken host page.

import { NextRequest, NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase/service";
import { env } from "@/lib/env";
import { hostedJobUrl, schemaEmploymentType, type PublicJob } from "@/lib/careers/jobs";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(request: Request, maxAge: number) {
  const origin = request.headers.get("origin");
  return {
    "access-control-allow-origin": origin ?? "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers":
      request.headers.get("access-control-request-headers") ?? "content-type",
    "access-control-max-age": "86400",
    "cache-control": `public, max-age=${maxAge}, s-maxage=${maxAge}`,
    vary: "Origin",
  };
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request, 0) });
}

export async function GET(request: NextRequest) {
  const site = request.nextUrl.searchParams.get("site") ?? "";
  const empty = NextResponse.json(
    { org: null, jobs: [] },
    { headers: corsHeaders(request, 60) },
  );
  if (!UUID.test(site)) return empty;

  const supabase = serviceClient();
  const { data: project } = await supabase
    .from("projects")
    .select("id, name, url, careers_enabled, tracker_enabled")
    .eq("id", site)
    .maybeSingle();

  const enabled = project?.careers_enabled && project?.tracker_enabled;
  if (!project || !enabled) return empty;

  const { data, error } = await supabase.rpc("public_job_postings", {
    p_project_id: site,
  });
  if (error) return empty;

  const jobs = ((data ?? []) as PublicJob[]).map((job) => ({
    ...job,
    responsibilities: job.responsibilities ?? [],
    qualifications: job.qualifications ?? [],
    // Precomputed here so the widget doesn't ship a lookup table it would
    // then have to keep in sync with ours.
    employment_type_schema: schemaEmploymentType(job.employment_type),
    canonical_url: hostedJobUrl(env.siteUrl, site, job.slug),
  }));

  return NextResponse.json(
    {
      org: { name: project.name, url: project.url },
      jobs,
    },
    // Short cache: job edits should show up quickly, but a busy careers page
    // shouldn't hit Postgres on every load.
    { headers: corsHeaders(request, 120) },
  );
}
