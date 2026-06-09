import "server-only";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";

export type OrgSummary = {
  id: string;
  name: string;
  role: OrgRole;
};

export type OrgRole = "owner" | "member" | "project_member";

export function isOrgWideRole(role: OrgRole | null | undefined): role is "owner" | "member" {
  return role === "owner" || role === "member";
}

export function missingOrgSchema(error: unknown) {
  const message =
    typeof error === "object" && error && "message" in error
      ? String((error as { message?: unknown }).message)
      : String(error ?? "");
  return /organization|default_org_id|organization_id|schema cache|relation .* does not exist|column .* does not exist/i.test(
    message,
  );
}

export function fallbackOrg(input: {
  email?: string | null;
  displayName?: string | null;
}): OrgSummary {
  return {
    id: "",
    name:
      cleanOrgName(input.displayName ?? null) ??
      defaultOrgName(input.email ?? null),
    role: "owner",
  };
}

export async function listUserOrgs(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<OrgSummary[]> {
  const { data, error } = await supabase
    .from("organization_members")
    .select("role, organization:organizations(id, name)")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  if (error) {
    if (missingOrgSchema(error)) return [];
    throw error;
  }

  return ((data ?? []) as Array<{
    role: OrgRole;
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
  const { data: profile, error: profileError } = await svc
    .from("profiles")
    .select("default_org_id, display_name, email")
    .eq("id", input.userId)
    .maybeSingle();
  if (profileError) {
    if (missingOrgSchema(profileError)) return fallbackOrg(input);
    throw profileError;
  }

  if (profile?.default_org_id) {
    const { data: org, error: orgError } = await svc
      .from("organizations")
      .select("id, name")
      .eq("id", profile.default_org_id)
      .maybeSingle();
    if (orgError) {
      if (missingOrgSchema(orgError)) return fallbackOrg(input);
      throw orgError;
    }
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
  if (error && missingOrgSchema(error)) return fallbackOrg(input);
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
  const { data: project, error } = await svc
    .from("projects")
    .select("organization_id, owner_id")
    .eq("id", input.projectId)
    .maybeSingle();
  if (error) {
    if (missingOrgSchema(error)) return "";
    throw error;
  }
  if (!project) throw new Error("Project not found.");
  if (project.organization_id) return project.organization_id as string;

  const org = await getOrCreateDefaultOrg({ userId: project.owner_id, email: input.email });
  await svc
    .from("projects")
    .update({ organization_id: org.id })
    .eq("id", input.projectId);
  return org.id;
}

export async function getProspectsOrgId(): Promise<string | null> {
  const svc = serviceClient();
  const { data: founder, error: founderError } = await svc
    .from("profiles")
    .select("id, email")
    .ilike("email", "anthony@profullstack.com")
    .maybeSingle();
  if (founderError || !founder) {
    if (founderError && missingOrgSchema(founderError)) return null;
    return null;
  }

  const { data: existing, error: existingError } = await svc
    .from("organizations")
    .select("id")
    .eq("owner_id", founder.id)
    .ilike("name", "Prospects")
    .maybeSingle();
  if (existingError) {
    if (missingOrgSchema(existingError)) return null;
    throw existingError;
  }
  if (existing?.id) return existing.id as string;

  const { data: org, error } = await svc
    .from("organizations")
    .insert({ owner_id: founder.id, name: "Prospects" })
    .select("id")
    .single();
  if (error) {
    if (missingOrgSchema(error)) return null;
    throw error;
  }
  if (!org?.id) return null;

  await svc.from("organization_members").upsert(
    {
      organization_id: org.id,
      user_id: founder.id,
      role: "owner",
    },
    { onConflict: "organization_id,user_id" },
  );
  return org.id as string;
}

function cleanOrgName(value: string | null) {
  const clean = value?.trim().replace(/\s+/g, " ").slice(0, 80);
  return clean ? `${clean} workspace` : null;
}

function defaultOrgName(email: string | null) {
  const base = email?.includes("@") ? email.split("@")[0] : "Default";
  return `${base || "Default"} workspace`;
}
