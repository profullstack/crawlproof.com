"use server";

import { headers } from "next/headers";
import { serviceClient } from "@/lib/supabase/service";
import { hashIp } from "@/lib/rateLimit";
import { newShareToken } from "@/lib/shareToken";
import { recordLead } from "@/lib/marketing";
import { sendWatchConfirmEmail } from "@/lib/email";
import { buildShareCard } from "@/lib/audit/share-card";
import {
  MAX_WATCHES_PER_EMAIL,
  isWatchCadence,
  isWatchEngine,
  normalizeWatchEmail,
  type WatchCadence,
  type WatchEngine,
} from "@/lib/watches";
import { env } from "@/lib/env";

// A watch is a standing promise to email an address. Both caps below exist so
// that promise can't be manufactured in bulk against addresses that never
// asked — the confirmation link is the real defence, but these keep the
// confirmation mail itself from becoming the abuse vector.
const WATCHES_PER_IP_PER_DAY = 5;

type Ok = { ok: true };
type Err = { ok: false; error: string };

/**
 * Create (or refresh) a watch from a public report page.
 *
 * Always returns the same neutral success, and always sends the same
 * confirmation mail, whether or not this address already watches this URL.
 * Reporting "you already watch this" would let anyone probe which addresses
 * are watching which sites, and confirming twice is harmless.
 */
export async function createWatch(input: {
  token: string;
  email: string;
  cadence?: string;
}): Promise<Ok | Err> {
  const email = normalizeWatchEmail(input.email);
  if (!email) return { ok: false, error: "Enter a valid email address." };

  const cadence: WatchCadence = isWatchCadence(input.cadence) ? input.cadence : "weekly";

  const svc = serviceClient();

  const { data: audit } = await svc
    .from("audits")
    .select("id, target_url, status, score, engine, summary")
    .eq("share_token", input.token)
    .maybeSingle();
  if (!audit) return { ok: false, error: "That report link is no longer valid." };

  // Only the free, self-hosted engines can be put on a recurring schedule, so
  // a watch can never become recurring LLM spend on an address we never
  // charged. A report from any other engine falls back to the rule engine.
  const engine: WatchEngine = isWatchEngine(audit.engine) ? audit.engine : "rule";
  const targetUrl = audit.target_url as string;

  // Respect the global marketing suppression list. Someone who unsubscribed
  // from CrawlProof entirely should not be able to be re-subscribed by a
  // form, even one they filled in themselves.
  // ilike here matches the rest of lib/marketing.ts, whose rows predate any
  // normalization guarantee. Over-matching only ever errs toward suppressing
  // a send, which is the safe direction for a suppression check.
  const { data: contact } = await svc
    .from("marketing_contacts")
    .select("unsubscribed_at")
    .ilike("email", email)
    .maybeSingle();
  if (contact?.unsubscribed_at) {
    return {
      ok: false,
      error: "That address has unsubscribed from CrawlProof email. Reply to any past email to re-enable it.",
    };
  }

  const hdrs = await headers();
  const ip =
    hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() || hdrs.get("x-real-ip") || "unknown";
  const ipHash = hashIp(ip);

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count: fromIp } = await svc
    .from("scan_watches")
    .select("id", { count: "exact", head: true })
    .eq("created_ip_hash", ipHash)
    .gte("created_at", since);
  if ((fromIp ?? 0) >= WATCHES_PER_IP_PER_DAY) {
    return { ok: false, error: "Too many watch requests from this network today. Try again tomorrow." };
  }

  // eq, not ilike: `_` and `%` are ILIKE wildcards and both are legal in an
  // address, so `john_doe@x.com` would match `johnXdoe@x.com` and wrongly
  // count against someone else's cap. This column always stores the
  // normalized form, so an exact match is both correct and sufficient.
  const { data: existingRows } = await svc
    .from("scan_watches")
    .select("id, target_url, engine")
    .eq("email", email)
    .is("unsubscribed_at", null);

  const existing = (existingRows ?? []).find(
    (r) => r.target_url === targetUrl && r.engine === engine,
  );

  if (!existing && (existingRows ?? []).length >= MAX_WATCHES_PER_EMAIL) {
    return {
      ok: false,
      error: `That address already watches ${MAX_WATCHES_PER_EMAIL} sites, which is the limit.`,
    };
  }

  const confirmToken = newShareToken();

  if (existing) {
    // Refresh rather than stack a duplicate: new confirm token, restored from
    // any prior unsubscribe, cadence updated to whatever was just chosen.
    const { error } = await svc
      .from("scan_watches")
      .update({
        cadence,
        confirm_token: confirmToken,
        unsubscribed_at: null,
        created_ip_hash: ipHash,
      })
      .eq("id", existing.id);
    if (error) return { ok: false, error: "Could not set up that watch." };
  } else {
    const { error } = await svc.from("scan_watches").insert({
      email,
      target_url: targetUrl,
      engine,
      cadence,
      confirm_token: confirmToken,
      unsubscribe_token: newShareToken(),
      origin_audit_id: audit.id,
      // Seed the baseline from the report they are looking at, so the first
      // re-scan can be reported as a real change rather than a first sighting.
      last_score: buildShareCard(audit as Parameters<typeof buildShareCard>[0]).score,
      created_ip_hash: ipHash,
    });
    if (error) return { ok: false, error: "Could not set up that watch." };
  }

  // A captured email, not a marketing opt-in — recordLead never upgrades
  // consent, and watch mail is transactional (they asked for this specific
  // thing about this specific URL).
  await recordLead({ email, source: "watch" });

  const card = buildShareCard(audit as Parameters<typeof buildShareCard>[0]);
  const base = env.siteUrl.replace(/\/$/, "");
  const res = await sendWatchConfirmEmail({
    to: email,
    host: card.host,
    label: card.label,
    cadence,
    confirmUrl: `${base}/watch/confirm/${confirmToken}`,
  });
  if (!res.sent) {
    return { ok: false, error: "Could not send the confirmation email. Try again shortly." };
  }

  return { ok: true };
}

/** Confirm a watch. Idempotent — clicking twice is a no-op, not an error. */
export async function confirmWatchByToken(
  token: string,
): Promise<{ ok: boolean; host?: string; cadence?: string }> {
  if (!token || token.length < 8) return { ok: false };
  const svc = serviceClient();
  const { data: row } = await svc
    .from("scan_watches")
    .select("id, target_url, cadence, verified_at")
    .eq("confirm_token", token)
    .maybeSingle();
  if (!row) return { ok: false };

  const host = (() => {
    try {
      return new URL(row.target_url as string).hostname.replace(/^www\./, "");
    } catch {
      return row.target_url as string;
    }
  })();

  if (!row.verified_at) {
    await svc
      .from("scan_watches")
      .update({
        verified_at: new Date().toISOString(),
        unsubscribed_at: null,
        // Start the clock at confirmation, not at request time.
        next_run_at: new Date().toISOString(),
      })
      .eq("id", row.id);
  }

  return { ok: true, host, cadence: row.cadence as string };
}

/** Stop a watch. Also idempotent, and reachable from every email we send. */
export async function stopWatchByToken(
  token: string,
): Promise<{ ok: boolean; host?: string }> {
  if (!token || token.length < 8) return { ok: false };
  const svc = serviceClient();
  const { data: row } = await svc
    .from("scan_watches")
    .update({ unsubscribed_at: new Date().toISOString() })
    .eq("unsubscribe_token", token)
    .select("target_url")
    .maybeSingle();
  if (!row) return { ok: false };
  const host = (() => {
    try {
      return new URL(row.target_url as string).hostname.replace(/^www\./, "");
    } catch {
      return row.target_url as string;
    }
  })();
  return { ok: true, host };
}
