import "server-only";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";

export type OrgSummary = {
  id: string;
  name: string;
  role: "owner" | "member";
};

export async function listUserOrgs(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<OrgSummary[]> {
  const { data } = await supabase
    .from("organization_members")
    .select("role, organization:organizations(id, name)")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });

  return ((data ?? []) as Array<{
    role: "owner" | "member";
    organization: { id: string; name: string } | { id: string; name: string }[] | null;
  }>)
    .map((row) => {
      const org = Array.isArray(row.organization)
        ? row.organization[0] ?? null
        : row.organization;
      return org ? { id: org.id, name: org.name, role: row.role } : null;
    })
    .filter((row): row is OrgSummary => !!row);
}

export async function getOrCreateDefaultOrg(input: {
  userId: string;
  email?: string | null;
  displayName?: string | null;
}): Promise<OrgSummary> {
  const svc = serviceClient();
  const { data: profile } = await svc
    .from("profiles")
    .select("default_org_id, display_name, email")
    .eq("id", input.userId)
    .maybeSingle();

  if (profile?.default_org_id) {
    const { data: org } = await svc
      .from("organizations")
      .select("id, name")
      .eq("id", profile.default_org_id)
      .maybeSingle();
    if (org) return { id: org.id, name: org.name, role: "owner" };
  }

  const name =
    cleanOrgName(input.displayName ?? profile?.display_name ?? null) ??
    defaultOrgName(input.email ?? profile?.email ?? null);

  const { data: org, error } = await svc
    .from("organizations")
    .insert({ owner_id: input.userId, name })
    .select("id, name")
    .single();
  if (error || !org) throw new Error(error?.message ?? "Could not create default org.");

  await svc.from("organization_members").upsert(
    {
      organization_id: org.id,
      user_id: input.userId,
      role: "owner",
    },
    { onConflict: "organization_id,user_id" },
  );
  await svc
    .from("profiles")
    .update({ default_org_id: org.id })
    .eq("id", input.userId)
    .is("default_org_id", null);

  return { id: org.id, name: org.name, role: "owner" };
}

export async function ensureProjectOrg(input: {
  projectId: string;
  userId: string;
  email?: string | null;
}): Promise<string> {
  const svc = serviceClient();
  const { data: project } = await svc
    .from("projects")
    .select("organization_id, owner_id")
    .eq("id", input.projectId)
    .maybeSingle();
  if (!project) throw new Error("Project not found.");
  if (project.organization_id) return project.organization_id as string;

  const org = await getOrCreateDefaultOrg({ userId: project.owner_id, email: input.email });
  await svc
    .from("projects")
    .update({ organization_id: org.id })
    .eq("id", input.projectId);
  return org.id;
}

function cleanOrgName(value: string | null) {
  const clean = value?.trim().replace(/\s+/g, " ").slice(0, 80);
  return clean ? `${clean} workspace` : null;
}

function defaultOrgName(email: string | null) {
  const base = email?.includes("@") ? email.split("@")[0] : "Default";
  return `${base || "Default"} workspace`;
}
