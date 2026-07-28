// Resolve the mailbox a project's outreach should send through.
//
// A connected mailbox (app/actions/mailbox.ts) is stored as the org's default
// email sender. Loading it here is what makes connecting one actually change
// where mail comes from — without this the setting would be decorative.
//
// Returns null whenever there is no usable mailbox, which is the signal to
// fall back to the shared Resend sender. Note "usable" includes decryptable:
// if the vault key has rotated out from under a stored credential we prefer a
// working shared sender over a hard failure mid-campaign.

import { serviceClient } from "@/lib/supabase/service";
import { decryptSecret } from "@/lib/sp/vault";

export type SenderMailbox = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  fromEmail: string;
  replyTo: string | null;
};

export async function loadProjectMailbox(projectId: string): Promise<SenderMailbox | null> {
  const sb = serviceClient();
  const { data: project } = await sb
    .from("projects")
    .select("organization_id")
    .eq("id", projectId)
    .maybeSingle();

  const orgId = (project?.organization_id as string | null) ?? null;
  if (!orgId) return null;

  const { data } = await sb
    .from("organization_outreach_configs")
    .select(
      "from_email, reply_to, smtp_host, smtp_port, smtp_secure, enc_smtp_user, enc_smtp_pass",
    )
    .eq("organization_id", orgId)
    .eq("channel", "email")
    .eq("provider", "smtp")
    .eq("is_default", true)
    .eq("enabled", true)
    .maybeSingle();

  if (!data) return null;
  const row = data as Record<string, unknown>;
  const host = (row.smtp_host as string | null) ?? "";
  const fromEmail = (row.from_email as string | null) ?? "";
  const encUser = row.enc_smtp_user as string | null;
  const encPass = row.enc_smtp_pass as string | null;
  if (!host || !fromEmail || !encPass) return null;

  try {
    return {
      host,
      port: (row.smtp_port as number | null) ?? 465,
      secure: (row.smtp_secure as boolean | null) ?? true,
      user: encUser ? decryptSecret(encUser) : fromEmail,
      pass: decryptSecret(encPass),
      fromEmail,
      replyTo: (row.reply_to as string | null) ?? null,
    };
  } catch {
    return null;
  }
}
