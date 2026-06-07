"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { sendOrgInviteEmail } from "@/lib/email";
import { env } from "@/lib/env";

async function requireOrgOwner(orgId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "Not authenticated." };

  const svc = serviceClient();
  const { data: org } = await svc
    .from("organizations")
    .select("id, name")
    .eq("id", orgId)
    .maybeSingle();
  if (!org) return { ok: false as const, error: "Organization not found." };

  const { data: member } = await svc
    .from("organization_members")
    .select("id")
    .eq("organization_id", orgId)
    .eq("user_id", user.id)
    .eq("role", "owner")
    .maybeSingle();
  if (!member) return { ok: false as const, error: "You must own this org." };

  return { ok: true as const, user, org, supabase, svc };
}

export async function inviteOrgMember(
  orgId: string,
  email: string,
): Promise<{ ok: boolean; error?: string }> {
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes("@")) {
    return { ok: false, error: "Invalid email address." };
  }

  const ctx = await requireOrgOwner(orgId);
  if (!ctx.ok) return { ok: false, error: ctx.error };
  const { user, org, svc } = ctx;

  const { data: ownerProfile } = await svc
    .from("profiles")
    .select("email")
    .eq("id", user.id)
    .maybeSingle();
  if (ownerProfile?.email?.toLowerCase() === normalized) {
    return { ok: false, error: "You can't invite yourself." };
  }

  // Already a member? Block re-invite of someone who's in.
  const { data: existingProfile } = await svc
    .from("profiles")
    .select("id")
    .eq("email", normalized)
    .maybeSingle();
  if (existingProfile) {
    const { data: existingMember } = await svc
      .from("organization_members")
      .select("id")
      .eq("organization_id", orgId)
      .eq("user_id", existingProfile.id)
      .maybeSingle();
    if (existingMember) {
      return { ok: false, error: "That person is already a member." };
    }
  }

  // Delete any existing invitation for this email (re-invite resets the timer)
  await svc
    .from("organization_invitations")
    .delete()
    .eq("organization_id", orgId)
    .eq("email", normalized);

  const { data: invitation, error: insertErr } = await svc
    .from("organization_invitations")
    .insert({ organization_id: orgId, email: normalized, invited_by: user.id })
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
  const acceptUrl = `${env.siteUrl}/invite/org/${invitation.token}`;

  const emailResult = await sendOrgInviteEmail({
    to: normalized,
    invitedBy: inviterName,
    orgName: org.name,
    acceptUrl,
  });

  if (!emailResult.sent) {
    await svc
      .from("organization_invitations")
      .delete()
      .eq("organization_id", orgId)
      .eq("email", normalized);
    return { ok: false, error: `Email failed: ${emailResult.error}` };
  }

  revalidatePath("/dashboard");
  return { ok: true };
}

export async function revokeOrgInvitation(
  orgId: string,
  invitationId: string,
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireOrgOwner(orgId);
  if (!ctx.ok) return { ok: false, error: ctx.error };

  const { error } = await ctx.svc
    .from("organization_invitations")
    .delete()
    .eq("id", invitationId)
    .eq("organization_id", orgId);

  if (error) return { ok: false, error: error.message };
  revalidatePath("/dashboard");
  return { ok: true };
}

export async function removeOrgMember(
  orgId: string,
  userId: string,
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireOrgOwner(orgId);
  if (!ctx.ok) return { ok: false, error: ctx.error };

  // Never remove an owner row via this path — owners leave by deleting or
  // transferring the org, not by being kicked from the member list.
  const { error } = await ctx.svc
    .from("organization_members")
    .delete()
    .eq("organization_id", orgId)
    .eq("user_id", userId)
    .eq("role", "member");

  if (error) return { ok: false, error: error.message };

  // Drop their default_org_id if it pointed at this org so they fall back
  // to a workspace they still belong to on next dashboard load.
  await ctx.svc
    .from("profiles")
    .update({ default_org_id: null })
    .eq("id", userId)
    .eq("default_org_id", orgId);

  revalidatePath("/dashboard");
  return { ok: true };
}

export type OrgTeamMember = {
  id: string;
  user_id: string;
  role: "owner" | "member";
  created_at: string;
  profile: { id: string; email: string; display_name: string } | null;
};

export type OrgPendingInvitation = {
  id: string;
  email: string;
  expires_at: string;
  created_at: string;
};

export async function listOrgTeam(orgId: string): Promise<
  | { ok: false; error: string }
  | {
      ok: true;
      isOwner: boolean;
      members: OrgTeamMember[];
      invitations: OrgPendingInvitation[];
    }
> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const svc = serviceClient();

  const { data: callerMembership } = await svc
    .from("organization_members")
    .select("role")
    .eq("organization_id", orgId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!callerMembership) return { ok: false, error: "Organization not found." };

  const { data: membersRaw } = await svc
    .from("organization_members")
    .select("id, user_id, role, created_at")
    .eq("organization_id", orgId)
    .order("created_at", { ascending: true });

  const userIds = (membersRaw ?? []).map((m: { user_id: string }) => m.user_id);
  const { data: profilesRaw } =
    userIds.length > 0
      ? await svc
          .from("profiles")
          .select("id, email, display_name")
          .in("id", userIds)
      : { data: [] as Array<{ id: string; email: string; display_name: string }> };

  const members: OrgTeamMember[] = (membersRaw ?? []).map(
    (m: { id: string; user_id: string; role: "owner" | "member"; created_at: string }) => ({
      id: m.id,
      user_id: m.user_id,
      role: m.role,
      created_at: m.created_at,
      profile:
        (profilesRaw ?? []).find(
          (p: { id: string }) => p.id === m.user_id,
        ) ?? null,
    }),
  );

  const isOwner = callerMembership.role === "owner";

  const { data: invitationsRaw } = isOwner
    ? await svc
        .from("organization_invitations")
        .select("id, email, expires_at, created_at")
        .eq("organization_id", orgId)
        .is("accepted_at", null)
        .order("created_at", { ascending: false })
    : { data: [] as OrgPendingInvitation[] };

  return {
    ok: true,
    isOwner,
    members,
    invitations: invitationsRaw ?? [],
  };
}
