// Do-not-contact storage for cold outreach.
//
// Global by design: an opt-out is a promise CrawlProof makes, not one that a
// single CrawlProof user makes. If someone tells us to stop, no account's
// outreach reaches them again.
//
// Kept separate from marketing_contacts. That table is the opt-in newsletter
// list, and sendMarketingBlast mails everyone on it — enrolling a cold
// prospect there just to hand them an unsubscribe link would subscribe them
// to the newsletter as a side effect of asking to be left alone.

import { serviceClient } from "@/lib/supabase/service";
import { domainOf, normalizeEmail, normalizeHost } from "./cold";

export type SuppressionScope = "email" | "domain" | "reddit_user";

export async function addSuppression(input: {
  scope: SuppressionScope;
  value: string;
  reason?: string;
  addedBy?: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  const value =
    input.scope === "domain"
      ? normalizeHost(input.value)
      : input.scope === "email"
        ? normalizeEmail(input.value)
        : input.value.replace(/^\/?u\//, "").trim().toLowerCase();
  if (!value) return { ok: false, error: "Empty suppression value." };

  const { error } = await serviceClient()
    .from("outreach_suppressions")
    .upsert(
      {
        scope: input.scope,
        value,
        reason: input.reason ?? null,
        added_by: input.addedBy ?? null,
      },
      { onConflict: "scope,value", ignoreDuplicates: true },
    );
  // A duplicate is the desired end state, not a failure.
  if (error && !/duplicate|conflict/i.test(error.message)) {
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

/**
 * Is this address off-limits? Checks the address itself and its domain, so
 * one "remove my company" covers every mailbox at it.
 */
export async function isEmailSuppressed(email: string): Promise<boolean> {
  const address = normalizeEmail(email);
  const domain = domainOf(address);
  if (!address) return true;
  const { data } = await serviceClient()
    .from("outreach_suppressions")
    .select("id, scope, value")
    .in("scope", ["email", "domain"])
    .in("value", [address, domain]);
  return (data ?? []).length > 0;
}

export async function isRedditUserSuppressed(username: string): Promise<boolean> {
  const value = username.replace(/^\/?u\//, "").trim().toLowerCase();
  if (!value) return true;
  const { data } = await serviceClient()
    .from("outreach_suppressions")
    .select("id")
    .eq("scope", "reddit_user")
    .eq("value", value)
    .limit(1);
  return (data ?? []).length > 0;
}

/** Newsletter opt-out also blocks cold mail — one "no" covers every channel. */
export async function marketingUnsubscribedAt(email: string): Promise<string | null> {
  const { data } = await serviceClient()
    .from("marketing_contacts")
    .select("unsubscribed_at")
    .ilike("email", normalizeEmail(email))
    .maybeSingle();
  return (data?.unsubscribed_at as string | null) ?? null;
}

export type TokenUnsubscribeResult = {
  ok: boolean;
  /** What we actually suppressed, for the confirmation page. */
  value?: string;
  scope?: SuppressionScope;
};

/**
 * Resolve a one-click unsubscribe token from a cold email.
 *
 * `scope: "domain"` is the "or anyone at example.com" link in the footer —
 * the thing a recipient wants when the pitch reached the wrong person at
 * their company and they are answering on everyone's behalf.
 */
export async function suppressByToken(
  token: string,
  scope: "email" | "domain" = "email",
): Promise<TokenUnsubscribeResult> {
  if (!token || token.length < 8) return { ok: false };
  const sb = serviceClient();
  const { data } = await sb
    .from("outreach_prospects")
    .select("id, contact_email, target_key, channel, reddit_username")
    .eq("unsubscribe_token", token)
    .maybeSingle();
  if (!data) return { ok: false };

  if (data.channel === "reddit") {
    const username = String(data.reddit_username ?? data.target_key ?? "");
    const res = await addSuppression({ scope: "reddit_user", value: username, reason: "opt-out link" });
    if (!res.ok) return { ok: false };
    await sb.from("outreach_prospects").update({ status: "skipped" }).eq("id", data.id);
    return { ok: true, value: `u/${username}`, scope: "reddit_user" };
  }

  const email = normalizeEmail(String(data.contact_email ?? ""));
  const value = scope === "domain" ? domainOf(email) || String(data.target_key ?? "") : email;
  if (!value) return { ok: false };

  const res = await addSuppression({ scope, value, reason: "opt-out link" });
  if (!res.ok) return { ok: false };
  await sb.from("outreach_prospects").update({ status: "skipped" }).eq("id", data.id);
  return { ok: true, value, scope };
}

/** Live (non-dry-run) sends by this user in the last 24 hours. */
export async function sendsInLast24h(input: {
  ownerId: string;
  channels: string[];
  subreddit?: string;
}): Promise<number> {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  let q = serviceClient()
    .from("outreach_sends")
    .select("id, target_url", { count: "exact", head: false })
    .eq("owner_id", input.ownerId)
    .eq("dry_run", false)
    .in("channel", input.channels)
    .gte("sent_at", since);
  if (input.subreddit) q = q.ilike("target_url", `%/r/${input.subreddit}/%`);
  const { data } = await q;
  return (data ?? []).length;
}
