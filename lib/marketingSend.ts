import { serviceClient } from "@/lib/supabase/service";
import { sendMarketingEmail } from "@/lib/email";

// Page through marketing_contacts and send a marketing email to each
// active subscriber. Caller supplies subject + html; the email helper
// appends the unsubscribe footer + List-Unsubscribe headers.
//
// Throttles to one send at a time with a small delay to stay under
// Resend's per-second limit (default 10/s on free; safe at ~5/s).
export async function sendMarketingBlast(input: {
  subject: string;
  html: string;
  // If set, only send to this address (and only if it's a real opted-in
  // contact). Useful for previewing before going live.
  previewTo?: string;
  // Send rate cap (emails per second). Default 5.
  perSecond?: number;
}): Promise<{ total: number; sent: number; failed: number }> {
  const svc = serviceClient();
  const limitPerSec = Math.max(1, Math.min(input.perSecond ?? 5, 20));
  const delayMs = Math.ceil(1000 / limitPerSec);

  let query = svc
    .from("marketing_contacts")
    .select("email, unsubscribe_token")
    .is("unsubscribed_at", null);

  if (input.previewTo) {
    query = query.ilike("email", input.previewTo);
  }

  const { data, error } = await query;
  if (error || !data) {
    console.error("[marketing] fetch contacts failed", error);
    return { total: 0, sent: 0, failed: 0 };
  }

  let sent = 0;
  let failed = 0;

  for (const row of data) {
    const email = row.email as string;
    const token = row.unsubscribe_token as string;
    const res = await sendMarketingEmail({
      to: email,
      subject: input.subject,
      html: input.html,
      unsubscribeToken: token,
    });
    if (res.sent) {
      sent += 1;
    } else {
      failed += 1;
      console.warn("[marketing] send failed", { to: email, error: res.error });
    }
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }

  return { total: data.length, sent, failed };
}
