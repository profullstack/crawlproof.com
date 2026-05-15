// Webhook delivery for autoblog articles (PRD §7).
//
// Reads one lx_article (status='ready') + its owning lx_site, builds the
// lx.publish_article payload, and POSTs to site.webhook_url with the
// site's bearer secret. Retries on transient failure (non-2xx response,
// network error). On 3xx redirects we follow once; on 4xx we do NOT
// retry (the receiver is asking us to stop). On 5xx + network errors
// we retry up to MAX_ATTEMPTS with backoff.
//
// Idempotency: the X-Crawlproof-Delivery UUID is stable across retries
// of the same lx_article. Receivers can hash it to detect replays.

import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

const UA = "Crawlproof-LinkExchange/1.0";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [0, 10_000, 60_000]; // 0s, 10s, 60s

type ArticleRow = {
  id: string;
  site_id: string;
  title: string;
  slug: string;
  meta_description: string;
  content_markdown: string;
  content_html: string;
  image_url: string | null;
  tags: string[];
  outbound_links: Array<{ url: string; anchor: string }>;
  internal_links: Array<{ url: string; title: string }>;
  status: string;
  webhook_delivery_id: string | null;
  webhook_attempts: number;
  created_at: string;
};

type SiteRow = {
  id: string;
  webhook_url: string | null;
  webhook_secret: string | null;
};

export type DeliveryResult = {
  ok: boolean;
  status: "published" | "failed";
  responseCode: number | null;
  attempts: number;
  error?: string;
};

function shouldRetry(status: number | null): boolean {
  if (status === null) return true; // network / timeout
  if (status >= 500) return true;
  if (status === 408 || status === 429) return true;
  return false;
}

async function postOnce(input: {
  url: string;
  secret: string;
  deliveryId: string;
  payload: unknown;
}): Promise<{ status: number | null; error?: string }> {
  const { url, secret, deliveryId, payload } = input;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${secret}`,
        "user-agent": UA,
        "x-crawlproof-delivery": deliveryId,
      },
      body: JSON.stringify(payload),
      redirect: "follow",
    });
    return { status: res.status };
  } catch (err) {
    return {
      status: null,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

function buildPayload(article: ArticleRow): unknown {
  return {
    event_type: "lx.publish_article",
    timestamp: new Date().toISOString(),
    data: {
      article: {
        id: article.id,
        title: article.title,
        slug: article.slug,
        content_markdown: article.content_markdown,
        content_html: article.content_html,
        meta_description: article.meta_description,
        image_url: article.image_url,
        tags: article.tags,
        outbound_links: article.outbound_links ?? [],
        internal_links: article.internal_links ?? [],
        created_at: article.created_at,
      },
    },
  };
}

export async function deliverArticle(
  articleId: string,
  deps: { supabase: SupabaseClient<any> },
): Promise<DeliveryResult> {
  const { supabase } = deps;

  // Atomic claim: only flip ready -> publishing once. If the row isn't
  // ready (already publishing or published), bail.
  const { data: claimed } = await supabase
    .from("lx_article")
    .update({ status: "publishing" })
    .eq("id", articleId)
    .eq("status", "ready")
    .select(
      "id, site_id, title, slug, meta_description, content_markdown, content_html, image_url, tags, outbound_links, internal_links, status, webhook_delivery_id, webhook_attempts, created_at",
    )
    .maybeSingle<ArticleRow>();
  if (!claimed) {
    return {
      ok: false,
      status: "failed",
      responseCode: null,
      attempts: 0,
      error: "article not in 'ready' state",
    };
  }

  const { data: site } = await supabase
    .from("lx_site")
    .select("id, webhook_url, webhook_secret")
    .eq("id", claimed.site_id)
    .maybeSingle<SiteRow>();
  if (!site?.webhook_url || !site?.webhook_secret) {
    await supabase
      .from("lx_article")
      .update({
        status: "failed",
        webhook_last_error: "webhook not configured",
      })
      .eq("id", articleId);
    return {
      ok: false,
      status: "failed",
      responseCode: null,
      attempts: 0,
      error: "webhook not configured",
    };
  }

  const deliveryId = claimed.webhook_delivery_id ?? crypto.randomUUID();
  const payload = buildPayload(claimed);

  let attempt = 0;
  let lastStatus: number | null = null;
  let lastError: string | undefined;

  while (attempt < MAX_ATTEMPTS) {
    if (RETRY_DELAYS_MS[attempt] > 0) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
    }
    attempt++;
    const r = await postOnce({
      url: site.webhook_url,
      secret: site.webhook_secret,
      deliveryId,
      payload,
    });
    lastStatus = r.status;
    lastError = r.error;
    if (r.status !== null && r.status >= 200 && r.status < 300) {
      // Success.
      await supabase
        .from("lx_article")
        .update({
          status: "published",
          published_at: new Date().toISOString(),
          webhook_delivery_id: deliveryId,
          webhook_response_code: r.status,
          webhook_attempts: attempt,
          webhook_last_error: null,
        })
        .eq("id", articleId);
      // Mark the originating keyword as published.
      await supabase
        .from("lx_keyword")
        .update({ status: "published" })
        .eq("article_id", articleId);
      return {
        ok: true,
        status: "published",
        responseCode: r.status,
        attempts: attempt,
      };
    }
    if (!shouldRetry(r.status)) break;
  }

  // All attempts failed.
  await supabase
    .from("lx_article")
    .update({
      status: "failed",
      webhook_delivery_id: deliveryId,
      webhook_response_code: lastStatus,
      webhook_attempts: attempt,
      webhook_last_error:
        lastError ?? (lastStatus !== null ? `HTTP ${lastStatus}` : "unknown error"),
    })
    .eq("id", articleId);
  await supabase
    .from("lx_keyword")
    .update({ status: "failed" })
    .eq("article_id", articleId);

  return {
    ok: false,
    status: "failed",
    responseCode: lastStatus,
    attempts: attempt,
    error: lastError ?? `HTTP ${lastStatus}`,
  };
}
