"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { getOrCreateDefaultOrg } from "@/lib/orgs";

type Ok<T = undefined> = { ok: true } & (T extends undefined ? {} : T);
type Err = { ok: false; error: string };

export async function createOrganization(input: {
  name: string;
}): Promise<Ok<{ id: string }> | Err> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const name = input.name.trim().replace(/\s+/g, " ").slice(0, 80);
  if (!name) return { ok: false, error: "Organization name is required." };

  const svc = serviceClient();
  const { data: org, error } = await svc
    .from("organizations")
    .insert({ owner_id: user.id, name })
    .select("id")
    .single();
  if (error || !org) return { ok: false, error: error?.message ?? "Could not create org." };

  const { error: memberError } = await svc.from("organization_members").upsert(
    {
      organization_id: org.id,
      user_id: user.id,
      role: "owner",
    },
    { onConflict: "organization_id,user_id" },
  );
  if (memberError) return { ok: false, error: memberError.message };

  await svc
    .from("profiles")
    .update({ default_org_id: org.id })
    .eq("id", user.id)
    .is("default_org_id", null);

  revalidatePath("/dashboard");
  return { ok: true, id: org.id as string };
}

export async function moveProjectToOrganization(input: {
  projectId: string;
  organizationId: string;
}): Promise<Ok | Err> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const svc = serviceClient();
  const { data: project } = await svc
    .from("projects")
    .select("id, owner_id, organization_id")
    .eq("id", input.projectId)
    .maybeSingle();
  if (!project) return { ok: false, error: "Project not found." };

  const { data: destinationMember } = await svc
    .from("organization_members")
    .select("id")
    .eq("organization_id", input.organizationId)
    .eq("user_id", user.id)
    .eq("role", "owner")
    .maybeSingle();
  if (!destinationMember) return { ok: false, error: "You must own the destination org." };

  if (project.organization_id) {
    const { data: sourceMember } = await svc
      .from("organization_members")
      .select("id")
      .eq("organization_id", project.organization_id)
      .eq("user_id", user.id)
      .eq("role", "owner")
      .maybeSingle();
    if (!sourceMember && project.owner_id !== user.id) {
      return { ok: false, error: "You must own the source org or project." };
    }
  } else if (project.owner_id !== user.id) {
    return { ok: false, error: "You must own the project." };
  }

  const { error } = await svc
    .from("projects")
    .update({
      organization_id: input.organizationId,
      owner_id: user.id,
    })
    .eq("id", input.projectId);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/dashboard");
  revalidatePath(`/projects/${input.projectId}`);
  return { ok: true };
}

export async function ensureDefaultOrganization(): Promise<Ok<{ id: string }> | Err> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };
  try {
    const org = await getOrCreateDefaultOrg({
      userId: user.id,
      email: user.email,
    });
    revalidatePath("/dashboard");
    return { ok: true, id: org.id };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not create default org.",
    };
  }
}
