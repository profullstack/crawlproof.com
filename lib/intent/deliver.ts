// Send new Buyer Intent leads where the owner works: Slack, Discord, a signed
// JSON webhook, and an email digest. Every destination URL is user supplied,
// so each one passes the private-address guard before we POST to it.

import { assertPublicTarget } from "@/lib/net-guard";
import { sendIntentDigestEmail } from "@/lib/email";
import { env } from "@/lib/env";
import { TIER_LABELS, signBody, sourceLabel, type LeadRow } from "./tiers";

export type DeliveryWatch = {
  id: string;
  name: string;
  slack_webhook_url: string | null;
  discord_webhook_url: string | null;
  webhook_url: string | null;
  webhook_secret: string | null;
  email_digest: boolean;
};

export type DeliveryResult = { channel: string; ok: boolean; error?: string };

const TIMEOUT_MS = 10_000;

async function post(url: string, body: string, headers: Record<string, string> = {}): Promise<void> {
  await assertPublicTarget(url);
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "CrawlProof-BuyerIntent/1.0", ...headers },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

function inboxUrl(watchId: string): string {
  return `${env.siteUrl}/dashboard/intent?watch=${watchId}`;
}

function line(l: LeadRow): string {
  return `${TIER_LABELS[l.tier]} (${l.score}) on ${sourceLabel(l.source)}: ${l.title || l.url}\n${l.url}`;
}

/** Only hot and worth-engaging leads ping chat; monitor-tier waits for the digest. */
export async function deliverLeads(watch: DeliveryWatch, leads: LeadRow[], email: string | null): Promise<DeliveryResult[]> {
  const results: DeliveryResult[] = [];
  if (!leads.length) return results;
  const loud = leads.filter((l) => l.tier !== "monitor").slice(0, 10);
  const run = async (channel: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      results.push({ channel, ok: true });
    } catch (err) {
      results.push({ channel, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  };

  if (watch.slack_webhook_url && loud.length) {
    await run("slack", () =>
      post(
        watch.slack_webhook_url!,
        JSON.stringify({
          text: `*${loud.length} new buyer-intent lead${loud.length === 1 ? "" : "s"} for ${watch.name}*\n\n${loud.map(line).join("\n\n")}\n\n<${inboxUrl(watch.id)}|Draft replies in CrawlProof>`,
        }),
      ),
    );
  }
  if (watch.discord_webhook_url && loud.length) {
    await run("discord", () =>
      post(
        watch.discord_webhook_url!,
        JSON.stringify({
          username: "CrawlProof",
          content: `**${loud.length} new buyer-intent lead${loud.length === 1 ? "" : "s"} for ${watch.name}**\n\n${loud.map(line).join("\n\n")}`.slice(0, 1990),
        }),
      ),
    );
  }
  if (watch.webhook_url) {
    for (const l of leads) {
      const body = JSON.stringify({
        event: "intent.lead",
        watch: { id: watch.id, name: watch.name },
        lead: { ...l, tier_label: TIER_LABELS[l.tier], source_label: sourceLabel(l.source) },
        sent_at: new Date().toISOString(),
      });
      const headers: Record<string, string> = { "x-crawlproof-event": "intent.lead" };
      if (watch.webhook_secret) headers["x-crawlproof-signature"] = signBody(watch.webhook_secret, body);
      await run("webhook", () => post(watch.webhook_url!, body, headers));
    }
  }
  if (watch.email_digest && email) {
    await run("email", async () => {
      const r = await sendIntentDigestEmail({
        to: email,
        watchName: watch.name,
        inboxUrl: inboxUrl(watch.id),
        leads: leads.map((l) => ({
          title: l.title,
          url: l.url,
          source: sourceLabel(l.source),
          score: l.score,
          tierLabel: TIER_LABELS[l.tier],
          snippet: l.snippet,
        })),
      });
      if (!r.sent) throw new Error(r.error ?? "not sent");
    });
  }
  return results;
}
