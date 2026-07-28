"use server";

import { revalidatePath } from "next/cache";
import { serviceClient } from "@/lib/supabase/service";
import { requireProjectAccess } from "@/lib/lx/currentSite";
import { encryptSecret } from "@/lib/sp/vault";
import { normalizeHost } from "@/lib/outreach/cold";
import { seedHost } from "@/lib/outreach/seedCredentials";

type Ok<T = Record<string, never>> = { ok: true } & T;
type Err = { ok: false; error: string };

async function requireOrg(
  projectId: string,
): Promise<{ ok: true; userId: string; organizationId: string } | Err> {
  if (!projectId) return { ok: false, error: "Missing project." };
  const access = await requireProjectAccess(projectId);
  if (!access.ok) return { ok: false, error: access.error };
  if (access.isViewer) return { ok: false, error: "Viewers can't manage seed logins." };

  const { data: project } = await serviceClient()
    .from("projects")
    .select("organization_id")
    .eq("id", projectId)
    .maybeSingle();
  const organizationId = (project?.organization_id as string | null) ?? null;
  if (!organizationId) {
    return { ok: false, error: "This project isn't in an organization, so there's nowhere to store a login." };
  }
  return { ok: true, userId: access.userId, organizationId };
}

/**
 * Store a login for a gated seed directory.
 *
 * Unlike the mailbox, the credential is not verified at save time: doing so
 * would mean driving a browser through someone else's login form inside a
 * server action, and a directory that is slow or briefly down would look like
 * a bad password. It is verified on the next tick instead, and the result is
 * recorded on the row so the UI can show whether it actually worked.
 */
export async function saveSeedCredentialAction(input: {
  projectId: string;
  host: string;
  username: string;
  password: string;
  loginUrl?: string;
}): Promise<Ok<{ note: string }> | Err> {
  const access = await requireOrg(input.projectId);
  if (!access.ok) return access;

  // Accept a full URL or a bare host — the value usually comes from a seed
  // URL the user pasted somewhere else.
  const host = input.host.includes("://")
    ? seedHost(input.host)
    : normalizeHost(input.host.trim());
  if (!host || !host.includes(".")) return { ok: false, error: "That doesn't look like a site." };
  if (!input.username.trim()) return { ok: false, error: "A username or email is required." };
  if (!input.password) return { ok: false, error: "A password is required." };

  const { error } = await serviceClient()
    .from("outreach_seed_credentials")
    .upsert(
      {
        organization_id: access.organizationId,
        created_by: access.userId,
        host,
        username: input.username.trim(),
        enc_password: encryptSecret(input.password),
        login_url: input.loginUrl?.trim() || null,
        // A new password invalidates whatever the last attempt concluded.
        verified_at: null,
        last_error: null,
      },
      { onConflict: "organization_id,host" },
    );
  if (error) return { ok: false, error: error.message };

  // Any campaign parked on this host can stop waiting.
  const { data: campaigns } = await serviceClient()
    .from("outreach_campaigns")
    .select("id, auth_required_hosts")
    .eq("project_id", input.projectId);
  for (const c of (campaigns as { id: string; auth_required_hosts: string[] | null }[] | null) ?? []) {
    const waiting = Array.isArray(c.auth_required_hosts) ? c.auth_required_hosts : [];
    const remaining = waiting.filter((u) => seedHost(u) !== host);
    if (remaining.length !== waiting.length) {
      await serviceClient()
        .from("outreach_campaigns")
        .update({ auth_required_hosts: remaining })
        .eq("id", c.id);
    }
  }

  revalidatePath(`/projects/${input.projectId}/leads`);
  return {
    ok: true,
    note: `Saved a login for ${host}. The next campaign tick will try it and report whether it worked.`,
  };
}

/**
 * Hand a verification code to a sign-in that is paused waiting for one.
 *
 * The browser session is still open on the other side of this, holding the
 * challenge page; the runner polls this row and types whatever lands here
 * into the live form. Nothing is stored — the waiter clears the column the
 * moment it reads it.
 */
export async function submitSeedVerificationCodeAction(input: {
  projectId: string;
  host: string;
  code: string;
}): Promise<{ ok: true } | Err> {
  const access = await requireOrg(input.projectId);
  if (!access.ok) return access;

  const code = input.code.trim();
  if (!code) return { ok: false, error: "Enter the code the site sent you." };
  if (!/^[A-Za-z0-9-]{4,12}$/.test(code)) {
    return { ok: false, error: "That doesn\u2019t look like a verification code." };
  }

  const { error } = await serviceClient()
    .from("outreach_seed_credentials")
    .update({ verification_code: code })
    .eq("organization_id", access.organizationId)
    .eq("host", normalizeHost(input.host));
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${input.projectId}/leads`);
  return { ok: true };
}

export async function deleteSeedCredentialAction(input: {
  projectId: string;
  host: string;
}): Promise<{ ok: true } | Err> {
  const access = await requireOrg(input.projectId);
  if (!access.ok) return access;

  const { error } = await serviceClient()
    .from("outreach_seed_credentials")
    .delete()
    .eq("organization_id", access.organizationId)
    .eq("host", normalizeHost(input.host));
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${input.projectId}/leads`);
  return { ok: true };
}
