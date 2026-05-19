// Crawlproof autoblog webhook receiver. Backed by @profullstack/autoblog,
// same contract as https://crawlproof.com/docs/autoblog-webhook —
// CloudEvents 1.0 envelope + Standard Webhooks signing.
//
// Per-integration bearer (kind='crawlproof') doubles as the HMAC secret.
// Articles upsert into blog_posts with source='crawlproof' and dedupe on
// (source, source_id) so retried deliveries are idempotent.

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { verifyAndParse } from "@profullstack/autoblog";
import { gatePost } from "@profullstack/autoblog/quality";
import { serviceClient } from "@/lib/supabase/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function tokensMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export async function POST(req: NextRequest) {
  const body = await req.text();

  const authHeader = req.headers.get("authorization") ?? "";
  const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!bearer) {
    return NextResponse.json({ error: "Missing access token" }, { status: 401 });
  }

  const supabase = serviceClient();
  const { data: integrations, error: lookupErr } = await supabase
    .from("autoblog_integrations")
    .select(
      "id, access_token, allowed_niches, min_word_count, max_link_density, banned_terms, min_quality_score",
    )
    .eq("kind", "crawlproof");
  if (lookupErr) {
    return NextResponse.json({ error: "Lookup failed" }, { status: 500 });
  }
  const integration = (integrations ?? []).find((row: { access_token: string }) =>
    tokensMatch(row.access_token, bearer),
  );
  if (!integration) {
    return NextResponse.json({ error: "Invalid access token" }, { status: 401 });
  }

  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    headers[k] = v;
  });
  const parsed = verifyAndParse({
    headers,
    body,
    opts: { secret: integration.access_token },
  });
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.reason }, { status: parsed.status });
  }

  const gate = await gatePost(parsed.post, {
    allowedNiches: integration.allowed_niches ?? [],
    heuristics: {
      minWordCount: integration.min_word_count ?? 500,
      maxLinkDensity: integration.max_link_density ?? 1.0,
      bannedTerms: integration.banned_terms ?? [],
    },
    minQualityScore: integration.min_quality_score ?? undefined,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? undefined,
  });
  if (!gate.ok) {
    return NextResponse.json(
      { error: `gate ${gate.stage} reject`, reasons: gate.reasons },
      { status: gate.stage === "niche" ? 403 : 422 },
    );
  }

  const { post } = parsed;
  const row = {
    source: "crawlproof",
    source_id: post.id,
    slug: post.slug,
    title: post.title,
    content_markdown: post.markdown ?? null,
    content_html: post.html,
    meta_description: post.excerpt ?? null,
    image_url: post.featured_image?.url ?? null,
    tags: post.tags,
    source_created_at: post.published_at,
    published_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const { error: upsertErr } = await supabase
    .from("blog_posts")
    .upsert([row], { onConflict: "source,source_id" });
  if (upsertErr) {
    console.error("[crawlproof webhook] upsert failed:", upsertErr);
    return NextResponse.json(
      { error: "Failed to persist article" },
      { status: 500 },
    );
  }

  try {
    await supabase.rpc("bump_autoblog_integration", {
      integration_id: integration.id,
    });
  } catch {
    // best-effort counter — ingestion already succeeded
  }

  return NextResponse.json({
    message: "Webhook processed successfully",
    slug: post.slug,
  });
}
