"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase/service";
import {
  recipientHash,
  sendOutreachEmail,
  sendOutreachSms,
} from "@/lib/outreach";

type Ok = { ok: true; provider: string };
type Err = { ok: false; error: string };

const MAX_SUBJECT = 120;
const MAX_EMAIL_BODY = 4000;
const MAX_SMS_BODY = 480;

export async function sendRecentAuditOutreach(input: {
  auditId: string;
  organizationId: string;
  channel: "email" | "sms";
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

  const reportUrl = `${process.env.NEXT_PUBLIC_SITE_URL ?? "https://crawlproof.com"}/r/${audit.share_token}`;
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
        })
      : await sendOutreachSms({ to: recipient, body: finalBody });

  await svc.from("recent_outreach_messages").insert({
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
  });

  if (!result.sent) return { ok: false, error: result.error ?? "Message failed to send." };

  revalidatePath("/recent");
  return { ok: true, provider: result.provider };
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
