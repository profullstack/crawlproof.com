"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { sendProjectInviteEmail } from "@/lib/email";
import { env } from "@/lib/env";

async function requireOwner(projectId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "Not authenticated." };

  const { data: project } = await supabase
    .from("projects")
    .select("id, name, owner_id")
    .eq("id", projectId)
    .eq("owner_id", user.id)
    .maybeSingle();
  if (!project) return { ok: false as const, error: "Project not found." };

  return { ok: true as const, user, project, supabase };
}

export type ProjectMemberRole = "member" | "viewer";

export async function inviteProjectMember(
  projectId: string,
  email: string,
  role: ProjectMemberRole = "member",
): Promise<{ ok: boolean; error?: string }> {
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes("@")) {
    return { ok: false, error: "Invalid email address." };
  }
  const memberRole: ProjectMemberRole = role === "viewer" ? "viewer" : "member";

  const ctx = await requireOwner(projectId);
  if (!ctx.ok) return { ok: false, error: ctx.error };
  const { user, project } = ctx;

  const { data: ownerProfile } = await ctx.supabase
    .from("profiles")
    .select("email")
    .eq("id", user.id)
    .maybeSingle();
  if (ownerProfile?.email?.toLowerCase() === normalized) {
    return { ok: false, error: "You can't invite yourself." };
  }

  const svc = serviceClient();

  // Delete any existing invitation for this email (re-invite resets the timer)
  await svc
    .from("project_invitations")
    .delete()
    .eq("project_id", projectId)
    .eq("email", normalized);

  const { data: invitation, error: insertErr } = await svc
    .from("project_invitations")
    .insert({ project_id: projectId, email: normalized, invited_by: user.id, role: memberRole })
    .select("token")
    .single();

  if (insertErr || !invitation) {
    return { ok: false, error: insertErr?.message ?? "Failed to create invitation." };
  }

  const { data: inviterProfile } = await svc
    .from("profiles")
    .select("display_name, email")
    .eq("id", user.id)
    .maybeSingle();

  const inviterName =
    inviterProfile?.display_name || inviterProfile?.email || "Someone";
  const acceptUrl = `${env.siteUrl}/invite/${invitation.token}`;

  const emailResult = await sendProjectInviteEmail({
    to: normalized,
    invitedBy: inviterName,
    projectName: project.name,
    acceptUrl,
  });

  if (!emailResult.sent) {
    await svc
      .from("project_invitations")
      .delete()
      .eq("project_id", projectId)
      .eq("email", normalized);
    return { ok: false, error: `Email failed: ${emailResult.error}` };
  }

  revalidatePath(`/projects/${projectId}/members`);
  return { ok: true };
}

export async function revokeProjectInvitation(
  projectId: string,
  invitationId: string,
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireOwner(projectId);
  if (!ctx.ok) return { ok: false, error: ctx.error };

  const { error } = await ctx.supabase
    .from("project_invitations")
    .delete()
    .eq("id", invitationId)
    .eq("project_id", projectId);

  if (error) return { ok: false, error: error.message };
  revalidatePath(`/projects/${projectId}/members`);
  return { ok: true };
}

export async function removeProjectMember(
  projectId: string,
  userId: string,
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireOwner(projectId);
  if (!ctx.ok) return { ok: false, error: ctx.error };

  const { data: project } = await ctx.supabase
    .from("projects")
    .select("organization_id")
    .eq("id", projectId)
    .maybeSingle();
  const orgId = (project as { organization_id?: string | null } | null)?.organization_id ?? null;

  const { error } = await ctx.supabase
    .from("project_members")
    .delete()
    .eq("project_id", projectId)
    .eq("user_id", userId);

  if (error) return { ok: false, error: error.message };

  if (orgId) {
    const svc = serviceClient();
    const { count } = await svc
      .from("project_members")
      .select("id, projects!inner(organization_id)", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("projects.organization_id", orgId);
    if (!count) {
      await svc
        .from("organization_members")
        .delete()
        .eq("organization_id", orgId)
        .eq("user_id", userId)
        .eq("role", "project_member");
    }
  }

  revalidatePath(`/projects/${projectId}/members`);
  return { ok: true };
}

export async function setProjectMemberRole(
  projectId: string,
  userId: string,
  role: ProjectMemberRole,
): Promise<{ ok: boolean; error?: string }> {
  const memberRole: ProjectMemberRole = role === "viewer" ? "viewer" : "member";
  const ctx = await requireOwner(projectId);
  if (!ctx.ok) return { ok: false, error: ctx.error };

  const { error } = await ctx.supabase
    .from("project_members")
    .update({ role: memberRole })
    .eq("project_id", projectId)
    .eq("user_id", userId);

  if (error) return { ok: false, error: error.message };
  revalidatePath(`/projects/${projectId}/members`);
  return { ok: true };
}

export type TeamMember = {
  id: string;
  user_id: string;
  created_at: string;
  role: ProjectMemberRole;
  profile: { id: string; email: string; display_name: string } | null;
};

export type PendingInvitation = {
  id: string;
  email: string;
  expires_at: string;
  created_at: string;
  role: ProjectMemberRole;
};

export async function listProjectTeam(projectId: string): Promise<
  | { ok: false; error: string }
  | {
      ok: true;
      isOwner: boolean;
      members: TeamMember[];
      invitations: PendingInvitation[];
    }
> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { data: project } = await supabase
    .from("projects")
    .select("id, owner_id")
    .eq("id", projectId)
    .maybeSingle();
  if (!project) return { ok: false, error: "Project not found." };

  const svc = serviceClient();

  const { data: membersRaw } = await svc
    .from("project_members")
    .select("id, user_id, created_at, role")
    .eq("project_id", projectId)
    .order("created_at", { ascending: true });

  const userIds = (membersRaw ?? []).map((m: any) => m.user_id);
  const { data: profilesRaw } =
    userIds.length > 0
      ? await svc
          .from("profiles")
          .select("id, email, display_name")
          .in("id", userIds)
      : { data: [] };

  const members: TeamMember[] = (membersRaw ?? []).map((m: any) => ({
    id: m.id,
    user_id: m.user_id,
    created_at: m.created_at,
    role: m.role === "viewer" ? "viewer" : "member",
    profile:
      (profilesRaw ?? []).find((p: any) => p.id === m.user_id) ?? null,
  }));

  const { data: invitationsRaw } = await svc
    .from("project_invitations")
    .select("id, email, expires_at, created_at, role")
    .eq("project_id", projectId)
    .is("accepted_at", null)
    .order("created_at", { ascending: false });

  return {
    ok: true,
    isOwner: project.owner_id === user.id,
    members,
    invitations: (invitationsRaw ?? []).map((i: any) => ({
      ...i,
      role: i.role === "viewer" ? "viewer" : "member",
    })),
  };
}
