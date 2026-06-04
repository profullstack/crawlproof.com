// Outrank webhook receiver. Outrank ships its own (non-CloudEvents)
// envelope: { event_type, timestamp, data: { articles: [...] } } with
// only an Authorization: Bearer header — no Standard Webhooks signature.
// We auth by looking up the bearer in autoblog_integrations (kind='outrank')
// and upsert each article into blog_posts dedup'd on (source, source_id).

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { revalidatePath } from "next/cache";
import { serviceClient } from "@/lib/supabase/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type OutrankArticle = {
  id?: string;
  title?: string;
  content_markdown?: string;
  content_html?: string;
  meta_description?: string;
  created_at?: string;
  image_url?: string;
  slug?: string;
  tags?: string[];
};

type OutrankPayload = {
  event_type?: string;
  timestamp?: string;
  data?: { articles?: OutrankArticle[] };
};

function tokensMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 200);
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    return NextResponse.json({ error: "Missing access token" }, { status: 401 });
  }

  const supabase = serviceClient();
  const { data: integrations, error: lookupErr } = await supabase
    .from("autoblog_integrations")
    .select("id, access_token")
    .eq("kind", "outrank");
  if (lookupErr) {
    return NextResponse.json({ error: "Lookup failed" }, { status: 500 });
  }
  const integration = (integrations ?? []).find((row: { access_token: string }) =>
    tokensMatch(row.access_token, token),
  );
  if (!integration) {
    return NextResponse.json({ error: "Invalid access token" }, { status: 401 });
  }

  let payload: OutrankPayload;
  try {
    payload = (await req.json()) as OutrankPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Outrank sends other event types (test pings, etc.) — ack so they
  // don't retry, but don't try to upsert.
  if (payload.event_type !== "publish_articles") {
    try {
      await supabase.rpc("bump_autoblog_integration", {
        integration_id: integration.id,
      });
    } catch {}
    return NextResponse.json({
      message: "Event ignored",
      event_type: payload.event_type ?? null,
    });
  }

  const articles = payload.data?.articles ?? [];
  if (!articles.length) {
    return NextResponse.json({ message: "No articles in payload" });
  }

  const rows = articles
    .filter((a) => a.title)
    .map((a) => {
      const slug = (a.slug && a.slug.trim()) || slugify(a.title || "");
      return {
        source: "outrank",
        source_id: a.id ?? null,
        slug,
        title: a.title!,
        content_markdown: a.content_markdown ?? null,
        content_html: a.content_html ?? null,
        meta_description: a.meta_description ?? null,
        image_url: a.image_url ?? null,
        tags: Array.isArray(a.tags) ? a.tags : [],
        source_created_at: a.created_at ?? null,
        published_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
    });

  const { error: upsertErr } = await supabase
    .from("blog_posts")
    .upsert(rows, { onConflict: "source,source_id" });
  if (upsertErr) {
    console.error("[outrank webhook] upsert failed:", upsertErr);
    return NextResponse.json(
      { error: "Failed to persist articles" },
      { status: 500 },
    );
  }

  try {
    await supabase.rpc("bump_autoblog_integration", {
      integration_id: integration.id,
    });
  } catch {}

  // Burst the ISR cache so the new posts surface immediately. Skip
  // per-slug paths — Outrank batches multiple articles per webhook,
  // and revalidating the index covers them all.
  revalidatePath("/blog");
  revalidatePath("/sitemap.xml");

  return NextResponse.json({
    message: "Webhook processed successfully",
    count: rows.length,
  });
}
