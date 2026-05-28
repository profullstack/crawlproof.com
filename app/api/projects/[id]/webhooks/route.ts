// GET  /api/projects/[id]/webhooks — list webhooks for a project (no secret).
// POST /api/projects/[id]/webhooks — create one (returns the freshly minted secret ONCE).

import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

const createSchema = z.object({
  url: z.string().url().max(2048),
  description: z.string().max(255).optional(),
  enabled: z.boolean().optional(),
});

type WebhookRow = {
  id: string;
  url: string;
  description: string | null;
  enabled: boolean;
  last_delivery_at: string | null;
  last_response_code: number | null;
  last_error: string | null;
  created_at: string;
};

function maskRows(rows: WebhookRow[]) {
  return rows.map((r) => ({ ...r, secret_set: true }));
}

export async function GET(
  _request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await ctx.params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data } = await supabase
    .from("tracker_webhooks")
    .select(
      "id, url, description, enabled, last_delivery_at, last_response_code, last_error, created_at",
    )
    .eq("project_id", projectId)
    .order("created_at", { ascending: false });

  return NextResponse.json({ data: maskRows((data ?? []) as WebhookRow[]) });
}

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await ctx.params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: z.infer<typeof createSchema>;
  try {
    body = createSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  const { data: project } = await supabase
    .from("projects")
    .select("id, owner_id")
    .eq("id", projectId)
    .maybeSingle();
  if (!project || project.owner_id !== user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const secret = randomBytes(32).toString("base64url");

  const { data, error } = await (supabase as any)
    .from("tracker_webhooks")
    .insert({
      project_id: projectId,
      url: body.url,
      secret,
      description: body.description ?? null,
      enabled: body.enabled ?? true,
      created_by: user.id,
    })
    .select(
      "id, url, description, enabled, last_delivery_at, last_response_code, last_error, created_at",
    )
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  return NextResponse.json({ data: { ...(data as WebhookRow), secret_set: true }, secret });
}
