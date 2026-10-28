// Customer webhooks for crawlproof.com, on @profullstack/webhooks.
//
// Endpoints and a durable delivery outbox live in Supabase (hub_webhook_*
// tables, migration 20261028160000_webhooks_hub.sql), read and written through
// the supabase-js store in ./supabase-store. `emit` only queues; the drainer the
// worker starts once at boot (worker/index.ts) sends with retries.
//
// Ownership: an endpoint belongs to an autoblog SITE (owner = lx_site.id), and
// the site's account manages it. Posts are per site, so a post for one blog must
// never fan out to another blog of the same account; scoping the owner to the
// site is what makes `emit(site.id, ...)` deliver to that blog only. Guest posts
// are emitted on the HOST site (target_site_id), which is the blog that prints
// them.
//
// Existing receivers keep verifying with no change on their side. They were
// built on @profullstack/autoblog's verifyAndParse, which:
//   1. requires `Authorization: Bearer <secret>`, byte for byte;
//   2. checks the Standard Webhooks signature with the WHOLE secret string as
//      the HMAC key (UTF-8 bytes, also when it starts with `whsec_`);
//   3. wants a CloudEvent whose data is `{ post }`.
// So the hub sends the bearer as an extra header, every secret a customer typed
// into /autoblog/setup is stored so its key bytes are that exact string (see
// storedSecretFor), and the event type and payload are the ones the old sender
// emitted (`com.crawlproof.post.published.v1`, `{ post }`).

import {
  Webhooks,
  checkUrl,
  secretToKey,
  isRetryable,
  type WebhookStore,
  type WebhooksOptions,
} from "@profullstack/webhooks";
import type { SupabaseClient } from "@supabase/supabase-js";
import { serviceClient } from "../supabase/service";
import { supabaseStore, type SupabaseLike } from "./supabase-store";

/** The documented autoblog event type (docs/autoblog-webhook), unchanged so receivers that check it still match. */
export const POST_PUBLISHED = "com.crawlproof.post.published.v1";

export const WEBHOOK_EVENT_TYPES = [POST_PUBLISHED] as const;

/**
 * Wait before attempts 2 and 3: the old in-process sender's 0s / 10s / 60s,
 * now kept in the store so a worker restart loses nothing.
 */
export const AUTOBLOG_BACKOFF_MS = [10_000, 60_000];

const PRINTABLE = /^[\x20-\x7e]+$/;

/**
 * What a receiver configured with `secret` checks the bearer against.
 *
 * - A plain string (every secret crawlproof had at migration time): itself.
 * - `whsec_` + base64 of a printable string: that string. This is how a
 *   customer-typed secret that itself starts with `whsec_` is stored, so the
 *   package's key (the decoded bytes) equals the old sender's key (the string).
 * - A hub-generated `whsec_` key (32 random bytes, never all printable): the
 *   `whsec_` string, which is what the owner was shown.
 */
export function bearerFor(secret: string): string {
  if (!secret.startsWith("whsec_")) return secret;
  try {
    const raw = secretToKey(secret).toString("utf8");
    if (PRINTABLE.test(raw) && Buffer.from(raw, "utf8").equals(secretToKey(secret))) return raw;
  } catch {
    // not base64: fall through
  }
  return secret;
}

/**
 * How to store a secret the customer typed (it came from their receiver) so the
 * HMAC key bytes stay that exact string. Only a `whsec_`-looking one needs
 * wrapping; the package already uses any other string as its UTF-8 bytes.
 */
export function storedSecretFor(typed: string): string {
  if (!typed.startsWith("whsec_")) return typed;
  return `whsec_${Buffer.from(typed, "utf8").toString("base64")}`;
}

/** The old autoblog sender's bearer, sent next to the Standard Webhooks headers. */
export const autoblogHeaders: NonNullable<WebhooksOptions["extraHeaders"]> = ({ secret }) => ({
  authorization: `Bearer ${bearerFor(secret)}`,
  "user-agent": "@profullstack/autoblog/0.1 (+@profullstack/webhooks)",
});

type Db = SupabaseClient<any>;

/**
 * Mirror a finished delivery onto the article it carried, so the dashboard's
 * per-article status, attempts, HTTP code and delivery id keep working.
 *
 * The event id is the article's webhook_delivery_id (set before emit). While
 * retries are pending the row stays `publishing` and only the counters move.
 * A 4xx other than 408/429 is final, as it was with the old sender: the
 * receiver refused the post (quality gate, bad config) and resending will not
 * change that, so the delivery is closed instead of retried.
 */
export function articleDeliveryRecorder(db: Db, store: WebhookStore): NonNullable<WebhooksOptions["onDelivery"]> {
  return async ({ delivery, ok }) => {
    if (delivery.event_type !== POST_PUBLISHED) return;
    let status = delivery.status;
    if (!ok && status === "pending" && !isRetryable(delivery.last_status)) {
      await store.updateDelivery(delivery.id, { status: "failed", updatedAt: Date.now() });
      status = "failed";
    }
    const common = {
      webhook_response_code: delivery.last_status,
      webhook_attempts: delivery.attempts,
    };
    if (ok) {
      const { data } = await db
        .from("lx_article")
        .select("id, published_at, created_at")
        .eq("webhook_delivery_id", delivery.event_id)
        .in("status", ["publishing", "failed"]);
      for (const row of (data as Array<{ id: string; published_at: string | null; created_at: string }> | null) ?? []) {
        // published_at is what the payload and the JSON-LD said (articleToPost:
        // the row's published_at, else created_at), so row and receiver agree.
        await db
          .from("lx_article")
          .update({ ...common, status: "published", webhook_last_error: null, published_at: row.published_at ?? row.created_at })
          .eq("id", row.id);
        await db.from("lx_keyword").update({ status: "published" }).eq("article_id", row.id);
      }
      return;
    }
    const error = delivery.last_error ?? (delivery.last_status ? `HTTP ${delivery.last_status}` : "delivery failed");
    if (status === "pending") {
      await db
        .from("lx_article")
        .update({ ...common, webhook_last_error: `${error} (retrying)` })
        .eq("webhook_delivery_id", delivery.event_id)
        .eq("status", "publishing");
      return;
    }
    const { data } = await db
      .from("lx_article")
      .update({ ...common, status: "failed", webhook_last_error: error })
      .eq("webhook_delivery_id", delivery.event_id)
      .eq("status", "publishing")
      .select("id");
    for (const row of (data as Array<{ id: string }> | null) ?? []) {
      await db.from("lx_keyword").update({ status: "failed" }).eq("article_id", row.id);
    }
  };
}

export type Hub = { hooks: Webhooks; store: WebhookStore };

export function createHub(db: Db, options: Partial<WebhooksOptions> = {}): Hub {
  const store = options.store ?? supabaseStore(db as unknown as SupabaseLike);
  const hooks = new Webhooks({
    store,
    source: (process.env.NEXT_PUBLIC_SITE_URL ?? "https://crawlproof.com").replace(/\/$/, ""),
    eventTypes: [...WEBHOOK_EVENT_TYPES],
    maxEndpoints: 10,
    backoffMs: AUTOBLOG_BACKOFF_MS,
    extraHeaders: autoblogHeaders,
    onDelivery: articleDeliveryRecorder(db, store),
    log: (m) => console.warn(`[webhooks] ${m}`),
    ...options,
  });
  return { hooks, store };
}

const KEY = Symbol.for("crawlproof.webhooks.hub");
type HubGlobal = typeof globalThis & { [KEY]?: Hub };

/**
 * The process-wide hub. On globalThis because Next bundles route handlers
 * separately; a module singleton would give each its own instance.
 */
export function getHub(): Hub {
  const g = globalThis as HubGlobal;
  if (!g[KEY]) g[KEY] = createHub(serviceClient());
  return g[KEY]!;
}

export const getHooks = (): Webhooks => getHub().hooks;

/** Tests: use this hub instead of the Supabase one. */
export function setHub(hub: Hub | null): void {
  const g = globalThis as HubGlobal;
  g[KEY]?.hooks.stop();
  if (hub) g[KEY] = hub;
  else delete g[KEY];
}

/**
 * Keep a site's autoblog endpoint (the URL + secret on /autoblog/setup) in the
 * hub: one per site, its id in lx_site.webhook_endpoint_id.
 *
 * The hub is the source of truth: /autoblog/setup shows the endpoint's current
 * URL and secret (siteEndpointConfig), so a save that leaves the fields alone
 * changes nothing here, and a secret rotated through the API is not undone.
 */
export async function syncSiteEndpoint(
  db: Db,
  site: { id: string; domain: string; webhook_endpoint_id?: string | null },
  next: { url: string | null; secret: string | null },
  hub: Hub = getHub(),
  guard: Parameters<typeof checkUrl>[1] = {},
): Promise<{ endpointId: string | null; error?: string }> {
  const { store } = hub;
  const existing = site.webhook_endpoint_id ? await store.getEndpoint(site.webhook_endpoint_id) : null;
  if (!next.url || !next.secret) {
    if (existing) await store.deleteEndpoint(existing.id);
    if (site.webhook_endpoint_id) await db.from("lx_site").update({ webhook_endpoint_id: null }).eq("id", site.id);
    return { endpointId: null };
  }
  const check = await checkUrl(next.url, guard);
  if (!check.ok) return { endpointId: existing?.id ?? null, error: `Webhook URL: ${check.reason}` };
  const now = Date.now();
  if (existing && existing.owner === site.id) {
    const patch: Record<string, unknown> = {};
    if (existing.url !== check.url) patch.url = check.url;
    if (bearerFor(existing.secret) !== next.secret) patch.secret = storedSecretFor(next.secret);
    if (Object.keys(patch).length) await store.updateEndpoint(existing.id, { ...patch, updatedAt: now });
    return { endpointId: existing.id };
  }
  const id = `wh_lx_${site.id.replace(/-/g, "")}`;
  if (await store.getEndpoint(id)) await store.deleteEndpoint(id);
  await store.insertEndpoint({
    id,
    owner: site.id,
    url: check.url,
    secret: storedSecretFor(next.secret),
    events: [POST_PUBLISHED],
    description: `autoblog: ${site.domain}`,
    enabled: true,
    failures: 0,
    disabledReason: null,
    createdAt: now,
    updatedAt: now,
  });
  await db.from("lx_site").update({ webhook_endpoint_id: id }).eq("id", site.id);
  return { endpointId: id };
}

/** The URL + secret /autoblog/setup should show: the hub endpoint's, as the receiver knows them. */
export async function siteEndpointConfig(
  endpointId: string | null | undefined,
  hub: Hub = getHub(),
): Promise<{ url: string; secret: string; enabled: boolean } | null> {
  if (!endpointId) return null;
  const e = await hub.store.getEndpoint(endpointId);
  return e ? { url: e.url, secret: bearerFor(e.secret), enabled: e.enabled } : null;
}
