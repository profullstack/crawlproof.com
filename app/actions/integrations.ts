"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";

type Ok<T = undefined> = { ok: true } & (T extends undefined ? {} : T);
type Err = { ok: false; error: string };

const ALLOWED_KINDS = ["outrank", "crawlproof"] as const;
export type IntegrationKind = (typeof ALLOWED_KINDS)[number];

const KIND_PREFIX: Record<IntegrationKind, string> = {
  outrank: "otrk_",
  crawlproof: "cp_lx_",
};

async function assertAdmin(): Promise<
  { ok: true; userId: string } | { ok: false; error: string }
> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { data: profile } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile?.is_admin) return { ok: false, error: "Admin only." };
  return { ok: true, userId: user.id };
}

export async function createIntegration(input: {
  name: string;
  kind: string;
}): Promise<Ok<{ accessToken: string }> | Err> {
  const adminCheck = await assertAdmin();
  if (!adminCheck.ok) return adminCheck;

  const kind: IntegrationKind = (ALLOWED_KINDS as readonly string[]).includes(
    input.kind,
  )
    ? (input.kind as IntegrationKind)
    : "outrank";
  const name = (input.name || "").trim().slice(0, 100);
  if (!name) return { ok: false, error: "Name is required." };

  // Prefix tells you at a glance which destination a leaked token came
  // from — and prevents a Crawlproof bearer from being silently usable
  // on the Outrank endpoint (the receivers scope lookups by kind too).
  const accessToken = `${KIND_PREFIX[kind]}${randomBytes(32).toString("base64url")}`;

  const svc = serviceClient();
  const { error } = await svc.from("autoblog_integrations").insert({
    name,
    kind,
    access_token: accessToken,
    created_by: adminCheck.userId,
  });
  if (error) return { ok: false, error: error.message };

  revalidatePath("/admin");
  return { ok: true, accessToken };
}

export async function revokeIntegration(input: {
  id: string;
}): Promise<Ok | Err> {
  const adminCheck = await assertAdmin();
  if (!adminCheck.ok) return adminCheck;

  const svc = serviceClient();
  const { error } = await svc
    .from("autoblog_integrations")
    .delete()
    .eq("id", input.id);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/admin");
  return { ok: true };
}
