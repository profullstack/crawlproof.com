// Worker-side alert processing: poll a user's due alerts (reserving SERP
// budget per call) then send ONE batched digest of every pending finding.
// Invoked from worker/index.ts's /alerts/check-user HTTP route.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Resend } from "resend";
import { env } from "@/lib/env";
import { checkAlert, type AlertRow } from "./engine";
import { buildDigest, type DigestGroup } from "./email";
import { SERP_CALLS_PER_MONTH, planFromProfile } from "./limits";
import { unsubscribeUrl } from "./tokens";

const ALERT_COLUMNS =
  "id, owner_id, email, category, label, input_term, compiled_query, recency, frequency, status, confirm_backlink, backlink_domain, seeded";

export async function processUserAlerts(
  svc: SupabaseClient,
  resend: Resend | null,
  input: { ownerId: string; alertIds: string[] },
): Promise<{ ok: boolean; checked: number; skippedBudget: number; emailed: boolean }> {
  const { data: profile } = await svc
    .from("profiles")
    .select("plan, email")
    .eq("id", input.ownerId)
    .maybeSingle();
  const plan = planFromProfile(profile?.plan as string | undefined);
  const cap = SERP_CALLS_PER_MONTH[plan];

  const { data: alertRows } = await svc
    .from("alerts")
    .select(ALERT_COLUMNS)
    .in("id", input.alertIds)
    .eq("status", "active");
  const alerts = (alertRows ?? []) as AlertRow[];

  let checked = 0;
  let skippedBudget = 0;
  for (const alert of alerts) {
    // Reserve one SERP call against the owner's monthly budget. When the free
    // budget is exhausted we skip rather than spend — the cost backstop.
    const { data: reserved } = await svc.rpc("consume_alert_serp_budget", {
      p_owner: input.ownerId,
      p_count: 1,
      p_cap: cap,
    });
    if (!reserved) {
      skippedBudget++;
      continue;
    }
    try {
      await checkAlert(svc, alert);
    } catch (err) {
      console.error(`[alerts] checkAlert ${alert.id} crashed`, err);
    }
    checked++;
  }

  const emailed = await sendPendingDigest(svc, resend, input.ownerId);
  return { ok: true, checked, skippedBudget, emailed };
}

type PendingRow = {
  id: string;
  alert_id: string;
  url: string;
  title: string | null;
  snippet: string | null;
  confirmed_backlink: boolean;
  alerts: { label: string | null; category: string | null } | null;
};

async function sendPendingDigest(
  svc: SupabaseClient,
  resend: Resend | null,
  ownerId: string,
): Promise<boolean> {
  const { data: pending } = await svc
    .from("alert_findings")
    .select("id, alert_id, url, title, snippet, confirmed_backlink, alerts(label, category)")
    .eq("owner_id", ownerId)
    .is("emailed_at", null)
    .order("created_at", { ascending: true })
    .limit(500);
  const rows = (pending ?? []) as unknown as PendingRow[];
  if (rows.length === 0) return false; // an empty digest is never sent

  const { data: profile } = await svc
    .from("profiles")
    .select("email")
    .eq("id", ownerId)
    .maybeSingle();
  const to = profile?.email as string | undefined;
  if (!to) return false;

  const groups = new Map<string, DigestGroup>();
  for (const r of rows) {
    const g =
      groups.get(r.alert_id) ??
      ({
        alertId: r.alert_id,
        label: r.alerts?.label ?? "Alert",
        category: r.alerts?.category ?? "",
        findings: [],
      } satisfies DigestGroup);
    g.findings.push({
      title: r.title,
      url: r.url,
      snippet: r.snippet,
      confirmed_backlink: r.confirmed_backlink,
    });
    groups.set(r.alert_id, g);
  }

  const digest = buildDigest({ ownerId, groups: [...groups.values()] });

  if (resend) {
    const res = await resend.emails.send({
      from: env.alertsFrom,
      to,
      subject: digest.subject,
      html: digest.html,
      text: digest.text,
      headers: {
        "List-Unsubscribe": `<${unsubscribeUrl(ownerId)}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });
    if (res.error) {
      console.error("[alerts] digest send failed", res.error);
      return false; // leave findings pending so the next cycle retries
    }
  } else {
    console.log(`[alerts] (no RESEND_API_KEY) would email ${to}: ${digest.subject}`);
  }

  const ids = rows.map((r) => r.id);
  await svc.from("alert_findings").update({ emailed_at: new Date().toISOString() }).in("id", ids);
  return true;
}
