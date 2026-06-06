"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import {
  recipientHash,
  sendOutreachEmail,
  sendOutreachSms,
  type OutreachConfig,
} from "@/lib/outreach";
import { missingOrgSchema } from "@/lib/orgs";

type Ok = { ok: true; provider: string };
type Err = { ok: false; error: string };

const MAX_SUBJECT = 120;
const MAX_EMAIL_BODY = 4000;
const MAX_SMS_BODY = 480;
type OutreachChannel = "email" | "sms" | "social";
type OutreachVisibility = "private" | "public";

export async function sendRecentAuditOutreach(input: {
  auditId: string;
  organizationId: string;
  channel: OutreachChannel;
  visibility?: OutreachVisibility;
  subject?: string;
  body: string;
}): Promise<Ok | Err> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const body = input.body.trim();
  if (!body) return { ok: false, error: "Message body is required." };
  if (input.channel === "sms" && body.length > MAX_SMS_BODY) {
    return { ok: false, error: `SMS must be ${MAX_SMS_BODY} characters or fewer.` };
  }
  if (input.channel === "email" && body.length > MAX_EMAIL_BODY) {
    return { ok: false, error: `Email must be ${MAX_EMAIL_BODY} characters or fewer.` };
  }
  if (input.channel === "social" && body.length > MAX_EMAIL_BODY) {
    return { ok: false, error: `Social message must be ${MAX_EMAIL_BODY} characters or fewer.` };
  }

  const svc = serviceClient();
  const access = await paidOrgOwner(svc, input.organizationId, user.id);
  if (!access.ok) return { ok: false, error: access.error };

  const { data: audit } = await svc
    .from("audits")
    .select("id, target_url, share_token, status, listed_public, pdf_email, phone")
    .eq("id", input.auditId)
    .maybeSingle();
  if (
    !audit ||
    audit.status !== "complete" ||
    !audit.listed_public ||
    !audit.share_token
  ) {
    return { ok: false, error: "Recent scan is not available for outreach." };
  }

  const reportUrl = `${process.env.NEXT_PUBLIC_SITE_URL ?? "https://crawlproof.com"}/r/${audit.share_token}`;
  const config = await loadOutreachConfig(svc, input.organizationId, input.channel);

  if (input.channel === "social") {
    const subject =
      cleanSubject(input.subject) ?? `CrawlProof social follow-up for ${hostOf(audit.target_url)}`;
    const { error: recordError } = await svc.from("recent_outreach_messages").insert({
      organization_id: input.organizationId,
      audit_id: input.auditId,
      sender_id: user.id,
      channel: input.channel,
      provider: config?.provider ?? "manual",
      recipient_hash: recipientHash(`${input.auditId}:${reportUrl}`),
      subject,
      body,
      status: "queued",
      provider_message_id: null,
      error: null,
      visibility: input.visibility === "public" ? "public" : "private",
    });
    if (recordError) return { ok: false, error: recordError.message };

    revalidatePath("/recent");
    return { ok: true, provider: config?.provider ?? "manual" };
  }

  const recipient =
    input.channel === "email"
      ? cleanEmail(audit.pdf_email)
      : cleanPhone(audit.phone);
  if (!recipient) {
    return {
      ok: false,
      error:
        input.channel === "email"
          ? "This scan does not have a captured email address."
          : "This scan does not have a captured phone number.",
    };
  }

  const finalBody = `${body}\n\nReport: ${reportUrl}`;
  const subject =
    cleanSubject(input.subject) ?? `CrawlProof follow-up for ${hostOf(audit.target_url)}`;

  const result =
    input.channel === "email"
      ? await sendOutreachEmail({
          to: recipient,
          subject,
          body: finalBody,
          replyTo: user.email,
          config,
        })
      : await sendOutreachSms({ to: recipient, body: finalBody, config });

  const { error: recordError } = await svc.from("recent_outreach_messages").insert({
    organization_id: input.organizationId,
    audit_id: input.auditId,
    sender_id: user.id,
    channel: input.channel,
    provider: result.provider,
    recipient_hash: recipientHash(recipient),
    subject: input.channel === "email" ? subject : null,
    body,
    status: result.sent ? "sent" : "failed",
    provider_message_id: result.providerMessageId ?? null,
    error: result.error ?? null,
    visibility: "private",
  });
  if (recordError) return { ok: false, error: recordError.message };

  if (!result.sent) return { ok: false, error: result.error ?? "Message failed to send." };

  revalidatePath("/recent");
  return { ok: true, provider: result.provider };
}

async function loadOutreachConfig(
  svc: ReturnType<typeof serviceClient>,
  organizationId: string,
  channel: OutreachChannel,
): Promise<OutreachConfig | null> {
  const { data, error } = await svc
    .from("organization_outreach_configs")
    .select(
      "provider, from_email, from_phone, reply_to, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass, api_key, account_sid, auth_token",
    )
    .eq("organization_id", organizationId)
    .eq("channel", channel)
    .eq("enabled", true)
    .order("is_default", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) {
    if (missingOrgSchema(error)) return null;
    throw error;
  }
  return (data as OutreachConfig | null) ?? null;
}

async function paidOrgOwner(
  svc: ReturnType<typeof serviceClient>,
  organizationId: string,
  userId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data: member } = await svc
    .from("organization_members")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("user_id", userId)
    .eq("role", "owner")
    .maybeSingle();
  if (!member) return { ok: false, error: "Only org owners can send outreach." };

  const { data: profile } = await svc
    .from("profiles")
    .select("plan")
    .eq("id", userId)
    .maybeSingle();
  if (profile?.plan === "pro" || profile?.plan === "team") return { ok: true };

  const { data: purchase } = await svc
    .from("credit_purchases")
    .select("id")
    .eq("owner_id", userId)
    .eq("status", "complete")
    .limit(1)
    .maybeSingle();
  if (purchase) return { ok: true };

  return { ok: false, error: "Outreach is available to paid org owners." };
}

function cleanEmail(value: string | null | undefined) {
  const email = value?.trim().toLowerCase();
  return email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function cleanPhone(value: string | null | undefined) {
  const phone = value?.trim();
  return phone && /^\+?[0-9().\-\s]{7,32}$/.test(phone) ? phone : null;
}

function cleanSubject(value: string | null | undefined) {
  const subject = value?.trim().replace(/\s+/g, " ").slice(0, MAX_SUBJECT);
  return subject || null;
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
