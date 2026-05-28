// PATCH  /api/projects/[id]/webhooks/[webhookId] — update {url,description,enabled} and/or rotate_secret.
// DELETE /api/projects/[id]/webhooks/[webhookId] — remove.

import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

const patchSchema = z
  .object({
    url: z.string().url().max(2048).optional(),
    description: z.string().max(255).nullable().optional(),
    enabled: z.boolean().optional(),
    rotate_secret: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.url !== undefined ||
      v.description !== undefined ||
      v.enabled !== undefined ||
      v.rotate_secret === true,
    { message: "No fields to update" },
  );

export async function PATCH(
  request: NextRequest,
  ctx: { params: Promise<{ id: string; webhookId: string }> },
) {
  const { id: projectId, webhookId } = await ctx.params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: z.infer<typeof patchSchema>;
  try {
    body = patchSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.url !== undefined) patch.url = body.url;
  if (body.description !== undefined) patch.description = body.description;
  if (body.enabled !== undefined) patch.enabled = body.enabled;

  let newSecret: string | undefined;
  if (body.rotate_secret) {
    newSecret = randomBytes(32).toString("base64url");
    patch.secret = newSecret;
    patch.last_delivery_at = null;
    patch.last_response_code = null;
    patch.last_error = null;
  }

  const { data, error } = await (supabase as any)
    .from("tracker_webhooks")
    .update(patch)
    .eq("id", webhookId)
    .eq("project_id", projectId)
    .select(
      "id, url, description, enabled, last_delivery_at, last_response_code, last_error, created_at",
    )
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  return NextResponse.json({
    data: { ...data, secret_set: true },
    ...(newSecret ? { secret: newSecret } : {}),
  });
}

export async function DELETE(
  _request: NextRequest,
  ctx: { params: Promise<{ id: string; webhookId: string }> },
) {
  const { id: projectId, webhookId } = await ctx.params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { error } = await supabase
    .from("tracker_webhooks")
    .delete()
    .eq("id", webhookId)
    .eq("project_id", projectId);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  return new NextResponse(null, { status: 204 });
}
