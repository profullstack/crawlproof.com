// Live-schema contract test for PostgREST embeds used in autoblog code paths.
//
// Why this exists: on 2026-05-19 the guest-post migration added
// author_site_id + target_site_id FKs from lx_article -> lx_site. Every
// place in the app that selected `lx_site!inner(...)` from lx_article
// silently broke — PostgREST started rejecting the embed as ambiguous
// (PGRST201), .maybeSingle() returned null, and the article preview page
// 404'd. The matcher swallowed the same error and returned empty results.
//
// This test runs the exact embed shapes we ship in production against the
// real DB, so the next FK / relationship change that breaks them fails CI
// instead of users.
//
// Gated on LIVE_SUPABASE_URL + LIVE_SUPABASE_SERVICE_ROLE_KEY — skipped
// when secrets aren't present so `pnpm test` keeps working everywhere.

import { describe, it, expect, beforeAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = process.env.LIVE_SUPABASE_URL;
const key = process.env.LIVE_SUPABASE_SERVICE_ROLE_KEY;
const suite = url && key ? describe : describe.skip;

suite("lx_article PostgREST embeds (live schema)", () => {
  let sb: SupabaseClient;

  beforeAll(() => {
    sb = createClient(url!, key!, { auth: { persistSession: false } });
  });

  // Each `it` mirrors a real select() shape from app code. We don't care
  // whether rows come back — only that PostgREST parses the embed without
  // PGRST201 (multiple-relationships) or PGRST200 (no-relationship).

  it("article preview page — app/(app)/projects/[id]/autoblog/articles/[articleId]/page.tsx", async () => {
    const { error } = await sb
      .from("lx_article")
      .select(
        "id, title, slug, meta_description, content_html, image_url, tags, internal_links, status, published_at, created_at, webhook_response_code, webhook_attempts, webhook_last_error, webhook_delivery_id, lx_site!lx_article_site_id_fkey!inner(user_id, project_id, domain, blog_root_url)",
      )
      .limit(1);
    expect(error).toBeNull();
  });

  it("retry route — app/api/lx/articles/[id]/retry/route.ts", async () => {
    const { error } = await sb
      .from("lx_article")
      .select("id, site_id, status, lx_site!lx_article_site_id_fkey!inner(user_id)")
      .limit(1);
    expect(error).toBeNull();
  });

  it("deliver action — app/actions/linkExchange.ts", async () => {
    const { error } = await sb
      .from("lx_article")
      .select("id, status, lx_site!lx_article_site_id_fkey!inner(user_id)")
      .limit(1);
    expect(error).toBeNull();
  });

  it("exchange matcher candidate pull — lib/lx/exchangeMatcher.ts", async () => {
    const { error } = await sb
      .from("lx_article")
      .select(
        "id, title, slug, meta_description, status, site:lx_site!lx_article_site_id_fkey!inner(id, domain, blog_root_url, niche, status, backlinks_enabled, inappropriate_content)",
      )
      .limit(1);
    expect(error).toBeNull();
  });

  it("exchange matcher network-size count — lib/lx/exchangeMatcher.ts", async () => {
    const { error } = await sb
      .from("lx_article")
      .select(
        "id, site:lx_site!lx_article_site_id_fkey!inner(backlinks_enabled, status, inappropriate_content)",
        { count: "exact", head: true },
      );
    expect(error).toBeNull();
  });

  it("guest-post matcher network-size count — lib/lx/guestPostMatcher.ts", async () => {
    const { error } = await sb
      .from("lx_article")
      .select(
        "id, site:lx_site!lx_article_site_id_fkey!inner(backlinks_enabled, status, inappropriate_content)",
        { count: "exact", head: true },
      );
    expect(error).toBeNull();
  });

  // Sanity check: the disambiguator names this test relies on actually
  // exist. If a future migration renames lx_article_site_id_fkey, every
  // test above flips red — this assertion just makes the failure mode
  // obvious instead of looking like a query bug.
  it("lx_article_site_id_fkey relationship is resolvable", async () => {
    const { error } = await sb
      .from("lx_article")
      .select("id, lx_site!lx_article_site_id_fkey(id)")
      .limit(1);
    expect(error).toBeNull();
  });
});
