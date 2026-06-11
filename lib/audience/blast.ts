import "server-only";
import { serviceClient } from "@/lib/supabase/service";
import { env } from "@/lib/env";
import { sendOutreachEmail, type OutreachConfig } from "@/lib/outreach";

export type BlastResult = {
  ok: boolean;
  total: number;
  sent: number;
  failed: number;
  skipped: number;
  error?: string;
  campaignId?: string;
};

// Mass-email an org's deduped audience through its configured email sender
// (SMTP or Resend — whichever is the org's default email config). Every
// message carries a one-click unsubscribe footer + List-Unsubscribe headers,
// and any globally-unsubscribed address (marketing_contacts) is skipped.
export async function sendOrgAudienceBlast(input: {
  organizationId: string;
  subject: string;
  html: string;
  createdBy?: string | null;
  // Send only to this address (must be a real, active audience contact).
  // Used to preview a campaign before going live.
  previewTo?: string;
  perSecond?: number;
}): Promise<BlastResult> {
  const svc = serviceClient();
  const limitPerSec = Math.max(1, Math.min(input.perSecond ?? 5, 20));
  const delayMs = Math.ceil(1000 / limitPerSec);

  // 1. Resolve the org's default email sender config.
  const { data: configRow, error: configErr } = await svc
    .from("organization_outreach_configs")
    .select(
      "id,provider,from_email,reply_to,smtp_host,smtp_port,smtp_secure,enc_smtp_user,enc_smtp_pass,enc_api_key",
    )
    .eq("organization_id", input.organizationId)
    .eq("channel", "email")
    .eq("enabled", true)
    .eq("is_default", true)
    .maybeSingle();
  if (configErr) return zero("Could not load sender config: " + configErr.message);
  if (!configRow) {
    return zero("No default email sender configured. Add an SMTP or Resend sender first.");
  }
  const config = configRow as unknown as OutreachConfig;

  // 2. Build the suppression set: globally-unsubscribed marketing contacts.
  const suppressed = await loadSuppressed(svc);

  // 3. Page through active audience contacts.
  const contacts = await loadActiveContacts(svc, input.organizationId, input.previewTo);
  if (contacts.length === 0) {
    return { ok: true, total: 0, sent: 0, failed: 0, skipped: 0 };
  }

  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const c of contacts) {
    if (suppressed.has(c.email)) {
      skipped += 1;
      continue;
    }
    const unsubUrl = `${env.siteUrl}/unsubscribe/org/${c.unsubscribe_token}`;
    const html = `${input.html}${unsubscribeFooter(unsubUrl)}`;
    const res = await sendOutreachEmail({
      to: c.email,
      subject: input.subject,
      body: htmlToText(input.html) + `\n\nUnsubscribe: ${unsubUrl}`,
      html,
      headers: {
        "List-Unsubscribe": `<${unsubUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
      config,
    });
    if (res.sent) sent += 1;
    else {
      failed += 1;
      console.warn("[audience.blast] send failed", { to: c.email, error: res.error });
    }
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }

  // 4. Record the campaign (skip the audit row for previews).
  let campaignId: string | undefined;
  if (!input.previewTo) {
    const { data: campaign } = await svc
      .from("organization_email_campaigns")
      .insert({
        organization_id: input.organizationId,
        created_by: input.createdBy ?? null,
        sender_config_id: configRow.id,
        subject: input.subject,
        sent_count: sent,
        failed_count: failed,
        skipped_count: skipped,
      })
      .select("id")
      .maybeSingle();
    campaignId = campaign?.id as string | undefined;
  }

  return { ok: true, total: contacts.length, sent, failed, skipped, campaignId };
}

function zero(error: string): BlastResult {
  return { ok: false, total: 0, sent: 0, failed: 0, skipped: 0, error };
}

async function loadActiveContacts(
  svc: ReturnType<typeof serviceClient>,
  organizationId: string,
  previewTo?: string,
): Promise<Array<{ email: string; unsubscribe_token: string }>> {
  if (previewTo) {
    const email = previewTo.trim().toLowerCase();
    const { data } = await svc
      .from("organization_audience_contacts")
      .select("email,unsubscribe_token,unsubscribed_at")
      .eq("organization_id", organizationId)
      .ilike("email", email)
      .maybeSingle();
    if (!data || data.unsubscribed_at) return [];
    return [{ email: data.email as string, unsubscribe_token: data.unsubscribe_token as string }];
  }

  const out: Array<{ email: string; unsubscribe_token: string }> = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await svc
      .from("organization_audience_contacts")
      .select("email,unsubscribe_token")
      .eq("organization_id", organizationId)
      .is("unsubscribed_at", null)
      .range(from, from + pageSize - 1);
    if (error || !data || data.length === 0) break;
    for (const r of data) {
      out.push({ email: r.email as string, unsubscribe_token: r.unsubscribe_token as string });
    }
    if (data.length < pageSize) break;
  }
  return out;
}

async function loadSuppressed(svc: ReturnType<typeof serviceClient>): Promise<Set<string>> {
  const set = new Set<string>();
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await svc
      .from("marketing_contacts")
      .select("email")
      .not("unsubscribed_at", "is", null)
      .range(from, from + pageSize - 1);
    if (error || !data || data.length === 0) break;
    for (const r of data) set.add(String(r.email).trim().toLowerCase());
    if (data.length < pageSize) break;
  }
  return set;
}

function unsubscribeFooter(unsubUrl: string): string {
  return `<hr style="border:none;border-top:1px solid #eee;margin:24px 0" />
    <p style="color:#888;font-size:12px">
      You're receiving this because you have an account on one of our products.
      <a href="${unsubUrl}" style="color:#888">Unsubscribe</a>.
    </p>`;
}

function htmlToText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
