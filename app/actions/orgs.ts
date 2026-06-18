"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import { getOrCreateDefaultOrg } from "@/lib/orgs";
import { encryptSecret } from "@/lib/sp/vault";

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
    .eq("id", user.id);

  revalidatePath("/dashboard");
  return { ok: true, id: org.id as string };
}

export async function renameOrganization(input: {
  orgId: string;
  name: string;
}): Promise<Ok | Err> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const name = input.name.trim().replace(/\s+/g, " ").slice(0, 80);
  if (!name) return { ok: false, error: "Organization name is required." };

  const svc = serviceClient();
  const { data: member } = await svc
    .from("organization_members")
    .select("id")
    .eq("organization_id", input.orgId)
    .eq("user_id", user.id)
    .eq("role", "owner")
    .maybeSingle();
  if (!member) return { ok: false, error: "You must own this org to rename it." };

  const { error } = await svc
    .from("organizations")
    .update({ name, updated_at: new Date().toISOString() })
    .eq("id", input.orgId);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/dashboard");
  return { ok: true };
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

export async function setDefaultOrganization(input: {
  orgId: string;
}): Promise<Ok | Err> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const svc = serviceClient();
  const { data: member } = await svc
    .from("organization_members")
    .select("id")
    .eq("organization_id", input.orgId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!member) return { ok: false, error: "Organization not found." };

  const { error } = await svc
    .from("profiles")
    .update({ default_org_id: input.orgId })
    .eq("id", user.id);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/dashboard");
  return { ok: true };
}

export async function saveOrganizationOutreachConfig(input: {
  organizationId: string;
  label: string;
  channel: "email" | "sms" | "social";
  provider: "smtp" | "resend" | "twilio" | "telnyx" | "manual";
  fromEmail?: string;
  fromPhone?: string;
  replyTo?: string;
  smtpHost?: string;
  smtpPort?: string;
  smtpSecure?: boolean;
  smtpUser?: string;
  smtpPass?: string;
  apiKey?: string;
  accountSid?: string;
  authToken?: string;
}): Promise<Ok<{ id: string }> | Err> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const svc = serviceClient();
  const { data: member } = await svc
    .from("organization_members")
    .select("id")
    .eq("organization_id", input.organizationId)
    .eq("user_id", user.id)
    .eq("role", "owner")
    .maybeSingle();
  if (!member) return { ok: false, error: "You must own this org." };

  const label = input.label.trim().replace(/\s+/g, " ").slice(0, 80);
  if (!label) return { ok: false, error: "Label is required." };
  if (!validOutreachProvider(input.channel, input.provider)) {
    return { ok: false, error: "Provider is not valid for this channel." };
  }
  const encryptedSecrets = encryptOutreachSecrets(input);
  if (!encryptedSecrets.ok) return encryptedSecrets;

  const patch = {
    organization_id: input.organizationId,
    created_by: user.id,
    label,
    channel: input.channel,
    provider: input.provider,
    enabled: true,
    is_default: true,
    from_email: clean(input.fromEmail),
    from_phone: clean(input.fromPhone),
    reply_to: clean(input.replyTo),
    smtp_host: clean(input.smtpHost),
    smtp_port: Number(input.smtpPort || 0) || null,
    smtp_secure: !!input.smtpSecure,
    smtp_user: null,
    smtp_pass: null,
    api_key: null,
    account_sid: clean(input.accountSid),
    auth_token: null,
    enc_smtp_user: encryptedSecrets.encSmtpUser,
    enc_smtp_pass: encryptedSecrets.encSmtpPass,
    enc_api_key: encryptedSecrets.encApiKey,
    enc_auth_token: encryptedSecrets.encAuthToken,
  };

  await svc
    .from("organization_outreach_configs")
    .update({ is_default: false })
    .eq("organization_id", input.organizationId)
    .eq("channel", input.channel)
    .eq("is_default", true);

  const { data, error } = await svc
    .from("organization_outreach_configs")
    .insert(patch)
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };

  revalidatePath("/dashboard");
  return { ok: true, id: data.id as string };
}

export async function deleteOrganizationOutreachConfig(input: {
  organizationId: string;
  configId: string;
}): Promise<Ok | Err> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const svc = serviceClient();
  const { data: member } = await svc
    .from("organization_members")
    .select("id")
    .eq("organization_id", input.organizationId)
    .eq("user_id", user.id)
    .eq("role", "owner")
    .maybeSingle();
  if (!member) return { ok: false, error: "You must own this org." };

  const { error } = await svc
    .from("organization_outreach_configs")
    .delete()
    .eq("id", input.configId)
    .eq("organization_id", input.organizationId);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/dashboard");
  return { ok: true };
}

export async function deleteOrganization(input: {
  orgId: string;
}): Promise<Ok | Err> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const svc = serviceClient();
  const { data: member } = await svc
    .from("organization_members")
    .select("id")
    .eq("organization_id", input.orgId)
    .eq("user_id", user.id)
    .eq("role", "owner")
    .maybeSingle();
  if (!member) return { ok: false, error: "You must own this org to delete it." };

  const { count } = await svc
    .from("projects")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", input.orgId);
  if (count && count > 0) {
    return { ok: false, error: `Move or delete the ${count} project(s) in this org first.` };
  }

  const { error } = await svc.from("organizations").delete().eq("id", input.orgId);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/dashboard");
  return { ok: true };
}

export async function mergeOrganization(input: {
  sourceOrgId: string;
  targetOrgId: string;
}): Promise<Ok | Err> {
  if (input.sourceOrgId === input.targetOrgId) {
    return { ok: false, error: "Source and target org must be different." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const svc = serviceClient();

  // Verify ownership of both orgs
  const { data: sourceOwner } = await svc
    .from("organization_members")
    .select("id")
    .eq("organization_id", input.sourceOrgId)
    .eq("user_id", user.id)
    .eq("role", "owner")
    .maybeSingle();
  if (!sourceOwner) return { ok: false, error: "You must own the source org." };

  const { data: targetOwner } = await svc
    .from("organization_members")
    .select("id")
    .eq("organization_id", input.targetOrgId)
    .eq("user_id", user.id)
    .eq("role", "owner")
    .maybeSingle();
  if (!targetOwner) return { ok: false, error: "You must own the target org." };

  // Move all projects
  const { error: projectsError } = await svc
    .from("projects")
    .update({ organization_id: input.targetOrgId, owner_id: user.id })
    .eq("organization_id", input.sourceOrgId);
  if (projectsError) return { ok: false, error: projectsError.message };

  // Move all audits
  const { error: auditsError } = await svc
    .from("audits")
    .update({ organization_id: input.targetOrgId })
    .eq("organization_id", input.sourceOrgId);
  if (auditsError) return { ok: false, error: auditsError.message };

  // Fix default_org_id for any profiles pointing at source org
  await svc
    .from("profiles")
    .update({ default_org_id: input.targetOrgId })
    .eq("default_org_id", input.sourceOrgId);

  // Delete source org (cascades members, outreach configs, recent_outreach_messages)
  const { error: deleteError } = await svc
    .from("organizations")
    .delete()
    .eq("id", input.sourceOrgId);
  if (deleteError) return { ok: false, error: deleteError.message };

  revalidatePath("/dashboard");
  return { ok: true };
}

function clean(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed || null;
}

function validOutreachProvider(
  channel: "email" | "sms" | "social",
  provider: "smtp" | "resend" | "twilio" | "telnyx" | "manual",
) {
  if (channel === "email") return provider === "smtp" || provider === "resend";
  if (channel === "sms") return provider === "twilio" || provider === "telnyx";
  return provider === "manual";
}

function encryptOutreachSecrets(input: {
  smtpUser?: string;
  smtpPass?: string;
  apiKey?: string;
  authToken?: string;
}):
  | {
      ok: true;
      encSmtpUser: string | null;
      encSmtpPass: string | null;
      encApiKey: string | null;
      encAuthToken: string | null;
    }
  | Err {
  try {
    return {
      ok: true,
      encSmtpUser: encryptClean(input.smtpUser),
      encSmtpPass: encryptClean(input.smtpPass),
      encApiKey: encryptClean(input.apiKey),
      encAuthToken: encryptClean(input.authToken),
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Could not encrypt sender credentials.",
    };
  }
}

function encryptClean(value: string | undefined) {
  const cleanValue = clean(value);
  return cleanValue ? encryptSecret(cleanValue) : null;
}
