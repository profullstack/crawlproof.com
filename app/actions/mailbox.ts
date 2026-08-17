"use server";

import { revalidatePath } from "next/cache";
import { serviceClient } from "@/lib/supabase/service";
import { requireProjectAccess } from "@/lib/lx/currentSite";
import { encryptSecret } from "@/lib/sp/vault";
import {
  discoverMailbox,
  passwordNoteFor,
  splitEmail,
  unreachableProvider,
  type MailboxDiscovery,
  type SocketType,
} from "@/lib/outreach/mailboxDiscovery";
import { verifyImap, verifySmtp } from "@/lib/outreach/mailboxVerify";

type Ok<T = Record<string, never>> = { ok: true } & T;
type Err = { ok: false; error: string };

/**
 * Connecting a mailbox means sending mail as that address, so it needs the
 * same bar as the rest of outreach: project access, and not a viewer.
 *
 * The credential is stored per organization, not per project, because that is
 * where the existing sender configs live — one connected mailbox serves every
 * project in the org rather than being retyped per client.
 */
async function requireMailboxAccess(
  projectId: string,
): Promise<{ ok: true; userId: string; organizationId: string } | Err> {
  if (!projectId) return { ok: false, error: "Missing project." };
  const access = await requireProjectAccess(projectId);
  if (!access.ok) return { ok: false, error: access.error };
  if (access.isViewer) {
    return { ok: false, error: "Viewers can't connect a mailbox on this project." };
  }

  const { data: project } = await serviceClient()
    .from("projects")
    .select("organization_id")
    .eq("id", projectId)
    .maybeSingle();
  const organizationId = (project?.organization_id as string | null) ?? null;
  if (!organizationId) {
    return {
      ok: false,
      error: "This project isn't in an organization yet, so there's nowhere to store the mailbox.",
    };
  }
  return { ok: true, userId: access.userId, organizationId };
}

export type MailboxProposal = {
  discovery: MailboxDiscovery;
  passwordNote: string | null;
  /** Set when the provider can't be reached from a server at all. */
  blocked: string | null;
};

/**
 * Step one: look up the settings and hand them back for the user to check.
 *
 * No password is accepted here. The user confirms the hostnames we found —
 * and how we found them — before typing a credential, so a wrong guess is
 * caught by a human rather than by a failed login with a real password
 * already in flight.
 */
export async function discoverMailboxAction(input: {
  projectId: string;
  email: string;
}): Promise<Ok<{ proposal: MailboxProposal }> | Err> {
  const access = await requireMailboxAccess(input.projectId);
  if (!access.ok) return access;

  if (!splitEmail(input.email)) {
    return { ok: false, error: "That doesn't look like an email address." };
  }

  const discovery = await discoverMailbox(input.email);
  if (!discovery) return { ok: false, error: "That doesn't look like an email address." };
  if (!discovery.smtp) {
    return {
      ok: false,
      error: "Couldn't work out an SMTP server for that domain. Enter the settings manually.",
    };
  }

  return {
    ok: true,
    proposal: {
      discovery,
      passwordNote: passwordNoteFor(discovery),
      blocked: unreachableProvider(discovery),
    },
  };
}

function socketOf(secure: boolean, port: number): SocketType {
  if (secure) return "SSL";
  return port === 587 || port === 143 ? "STARTTLS" : "plain";
}

/**
 * Step two: log in with the confirmed settings, then store the password
 * encrypted.
 *
 * The order matters. Verification happens first and a failure stores nothing,
 * so the table never accumulates credentials that were never known to work.
 * The password reaches the database only as AES-256-GCM ciphertext
 * (lib/sp/vault.ts) — the plaintext `smtp_pass` column is explicitly nulled
 * rather than left alone, so a mailbox can never be written in the clear.
 *
 * The IMAP check is advisory: outreach only needs SMTP to send, and some
 * hosts issue send-only credentials. A failing IMAP login is reported back as
 * a note rather than blocking the connection.
 */
export async function connectMailboxAction(input: {
  projectId: string;
  email: string;
  password: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  imapHost?: string;
  imapPort?: number;
  imapSecure?: boolean;
  imapUser?: string;
  discoverySource?: string;
  discoveryDetail?: string;
}): Promise<Ok<{ imapNote: string | null }> | Err> {
  const access = await requireMailboxAccess(input.projectId);
  if (!access.ok) return access;

  const parts = splitEmail(input.email);
  if (!parts) return { ok: false, error: "That doesn't look like an email address." };
  if (!input.password) return { ok: false, error: "A password is required." };
  if (!input.smtpHost || !input.smtpPort) {
    return { ok: false, error: "An SMTP host and port are required." };
  }

  const address = `${parts.local}@${parts.domain}`;
  const smtpUser = input.smtpUser.trim() || address;

  const smtp = await verifySmtp(
    {
      protocol: "smtp" as const,
      host: input.smtpHost.trim(),
      port: input.smtpPort,
      socket: socketOf(input.smtpSecure, input.smtpPort),
      username: smtpUser,
    },
    input.password,
  );
  if (!smtp.ok) return { ok: false, error: smtp.error };

  let imapNote: string | null = null;
  if (input.imapHost && input.imapPort) {
    const imap = await verifyImap(
      {
        protocol: "imap" as const,
        host: input.imapHost.trim(),
        port: input.imapPort,
        socket: socketOf(input.imapSecure ?? true, input.imapPort),
        username: (input.imapUser ?? "").trim() || address,
      },
      input.password,
    );
    if (!imap.ok) {
      imapNote = `Sending works. Reading the mailbox didn't: ${imap.error}`;
    }
  }

  const svc = serviceClient();
  const patch = {
    organization_id: access.organizationId,
    created_by: access.userId,
    label: address,
    channel: "email" as const,
    provider: "smtp" as const,
    enabled: true,
    is_default: true,
    from_email: address,
    reply_to: address,
    smtp_host: input.smtpHost.trim(),
    smtp_port: input.smtpPort,
    smtp_secure: input.smtpSecure,
    // Never persist a mailbox credential in plaintext, even transiently.
    smtp_user: null,
    smtp_pass: null,
    enc_smtp_user: encryptSecret(smtpUser),
    enc_smtp_pass: encryptSecret(input.password),
    imap_host: input.imapHost?.trim() || null,
    imap_port: input.imapPort ?? null,
    imap_secure: input.imapSecure ?? null,
    imap_user: (input.imapUser ?? "").trim() || (input.imapHost ? address : null),
    discovery_source: input.discoverySource ?? "manual",
    discovery_detail: input.discoveryDetail ?? null,
    verified_at: new Date().toISOString(),
  };

  // One default email sender per org — demote the incumbent first so the
  // partial unique index stays satisfied.
  await svc
    .from("organization_outreach_configs")
    .update({ is_default: false })
    .eq("organization_id", access.organizationId)
    .eq("channel", "email")
    .eq("is_default", true);

  const { error } = await svc.from("organization_outreach_configs").insert(patch);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/dashboard/projects/${input.projectId}/leads`);
  return { ok: true, imapNote };
}

/** Forget a connected mailbox, credential and all. */
export async function disconnectMailboxAction(input: {
  projectId: string;
  configId: string;
}): Promise<{ ok: true } | Err> {
  const access = await requireMailboxAccess(input.projectId);
  if (!access.ok) return access;

  const { error } = await serviceClient()
    .from("organization_outreach_configs")
    .delete()
    .eq("id", input.configId)
    .eq("organization_id", access.organizationId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/dashboard/projects/${input.projectId}/leads`);
  return { ok: true };
}
