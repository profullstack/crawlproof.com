// Backfill images onto posts that published without them.
//
// Image generation is the one step of the article pipeline with no second
// provider: the text falls back openai -> anthropic, but gpt-image-2 is the
// only thing that draws. Every image call is therefore best-effort, wrapped
// in a try/catch that warns and carries on, because losing an illustration
// is not worth losing the article. The cost of that trade only showed up in
// August 2026: OpenAI's quota lapsed for a few days, every post in the
// window published with a null hero and no inline art, and because the
// failure was a console.warn on a worker nobody read, the first report came
// from someone looking at the blog.
//
// This closes the loop. A post that lost its images keeps enough state to
// get them back — the hero prompt is derived entirely from columns we
// store (title, excerpt, tags, niche), and a failed inline image now leaves
// a PENDING marker naming its own prompt. So the images are recoverable for
// as long as the row exists, and a transient outage becomes a delay rather
// than a permanent hole.
//
// Deliberately small per pass: four "high" 1536x1024 images is real money
// and ~60s of wall clock, so the sweep takes a couple of articles at a time
// and lets the next tick pick up the rest.

import type { SupabaseClient } from "@supabase/supabase-js";
import type OpenAI from "openai";
import { markdownToHtml } from "../markdown";
import {
  generateImage,
  generateInlineImage,
  parsePendingInlineMarkers,
  uploadImage,
  type BannerStyle,
} from "./articleGen";

// How far back to look. An article old enough to have been read already is
// not worth paying to re-illustrate.
const MAX_AGE_DAYS = 45;

export type ImageRepairResult = {
  scanned: number;
  articlesRepaired: number;
  heroesRestored: number;
  inlineRestored: number;
  failures: string[];
};

type ArticleRow = {
  id: string;
  site_id: string;
  slug: string;
  title: string;
  excerpt: string | null;
  meta_description: string | null;
  tags: string[] | null;
  image_url: string | null;
  content_markdown: string;
  lx_site: {
    niche: string | null;
    target_audiences: string[] | null;
    domain: string | null;
    banner_style: string | null;
  } | null;
};

export async function repairMissingArticleImages(
  supabase: SupabaseClient<any>,
  openai: OpenAI,
  opts: { limit?: number; siteId?: string; now?: Date } = {},
): Promise<ImageRepairResult> {
  const limit = opts.limit ?? 2;
  const since = new Date(
    (opts.now ?? new Date()).getTime() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const result: ImageRepairResult = {
    scanned: 0,
    articlesRepaired: 0,
    heroesRestored: 0,
    inlineRestored: 0,
    failures: [],
  };

  // Two independent symptoms of the same outage: a null hero, or an inline
  // marker still waiting. PostgREST `or` keeps it to one round trip.
  let query = supabase
    .from("lx_article")
    .select(
      "id, site_id, slug, title, excerpt, meta_description, tags, image_url, content_markdown, lx_site!lx_article_site_id_fkey(niche, target_audiences, domain, banner_style)",
    )
    .gte("created_at", since)
    .or("image_url.is.null,content_markdown.like.*INLINE_IMAGE_PENDING*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (opts.siteId) query = query.eq("site_id", opts.siteId);

  const { data, error } = await query;
  if (error) {
    result.failures.push(`query: ${error.message}`);
    return result;
  }

  const rows = (data ?? []) as unknown as ArticleRow[];
  result.scanned = rows.length;

  for (const row of rows) {
    const site = row.lx_site;
    let markdown = row.content_markdown;
    let heroUrl = row.image_url;
    let changed = false;

    // Hero. Rebuilt from stored columns, so it comes out equivalent to
    // what the original run would have produced.
    if (!heroUrl) {
      try {
        const bytes = await generateImage(openai, {
          title: row.title,
          excerpt: row.excerpt,
          metaDescription: row.meta_description,
          tags: row.tags,
          niche: site?.niche ?? null,
          audiences: site?.target_audiences ?? null,
          brand: site?.domain ?? null,
          style: (site?.banner_style as BannerStyle | null) ?? null,
        });
        if (bytes) {
          heroUrl = await uploadImage(supabase, row.site_id, row.slug, bytes);
          if (heroUrl) {
            changed = true;
            result.heroesRestored += 1;
          }
        }
      } catch (err) {
        result.failures.push(
          `${row.slug} hero: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Inline. Each marker carries the brief it was generated from, and is
    // replaced in place so the image lands back in its own section.
    const pending = parsePendingInlineMarkers(markdown);
    for (const spec of pending) {
      try {
        const bytes = await generateInlineImage(openai, spec.prompt, site?.niche ?? null, {
          kind: spec.kind,
        });
        if (!bytes) continue;
        const url = await uploadImage(
          supabase,
          row.site_id,
          `${row.slug}-inline-${spec.index}`,
          bytes,
        );
        if (!url) continue;
        markdown = markdown.replace(
          spec.raw,
          `![${spec.alt.replace(/[\[\]]/g, "")}](${url})`,
        );
        changed = true;
        result.inlineRestored += 1;
      } catch (err) {
        result.failures.push(
          `${row.slug} inline ${spec.index}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (!changed) continue;

    // Re-render only when the body actually moved; a hero-only repair
    // leaves the HTML untouched.
    const patch: Record<string, unknown> = { image_url: heroUrl };
    if (markdown !== row.content_markdown) {
      try {
        patch.content_markdown = markdown;
        patch.content_html = await markdownToHtml(markdown);
      } catch (err) {
        result.failures.push(
          `${row.slug} render: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
    }

    // Clear the recorded reason only once nothing is outstanding, so a
    // partial recovery still reads as needing attention.
    const stillMissing =
      !heroUrl || parsePendingInlineMarkers(markdown).length > 0;
    if (!stillMissing) patch.generation_error = null;

    const { error: updErr } = await supabase
      .from("lx_article")
      .update(patch)
      .eq("id", row.id);
    if (updErr) {
      result.failures.push(`${row.slug} update: ${updErr.message}`);
      continue;
    }
    result.articlesRepaired += 1;
    console.log(
      `[lx repair] images restored for ${row.slug} (hero=${heroUrl ? "yes" : "no"}, inline=${pending.length})`,
    );
  }

  return result;
}
