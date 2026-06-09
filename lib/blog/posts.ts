import { serviceClient } from "@/lib/supabase/service";

export type Post = {
  slug: string;
  title: string;
  date: string;
  excerpt: string;
  /** Static posts: plain-text body. DB-backed posts leave this empty. */
  body: string;
  /** DB-backed posts only: pre-rendered HTML (autoblog receivers). */
  html?: string | null;
  source: "static" | "outrank" | "crawlproof";
  image_url?: string | null;
};

// Static, hand-written posts kept here so the blog never depends on the
// DB for its first articles. Currently empty — the seed "what is AEO"
// and "llms.txt and skill.md" stubs were thin placeholders; once real
// autoblog-generated articles started landing in blog_posts they became
// noise in the index, so we removed them.
export const posts: Post[] = [];

export function findPost(slug: string): Post | undefined {
  return posts.find((p) => p.slug === slug);
}

type BlogPostRow = {
  slug: string;
  title: string;
  meta_description: string | null;
  content_html: string | null;
  content_markdown: string | null;
  image_url: string | null;
  published_at: string;
  source_created_at: string | null;
  source: string;
};

// Resolve the best date string (YYYY-MM-DD) for a post row.
// Prefer source_created_at (the date the article was actually written/
// published by the autoblog source) over published_at (which reflects
// the server clock at ingest time and may be skewed into the future
// if the server's system clock is ahead of wall-clock time).
function resolveDate(row: BlogPostRow): string {
  const candidate = row.source_created_at ?? row.published_at;
  return candidate.slice(0, 10);
}

function rowToPost(row: BlogPostRow): Post {
  return {
    slug: row.slug,
    title: row.title,
    date: resolveDate(row),
    excerpt: row.meta_description ?? "",
    body: "",
    html: row.content_html,
    source: (row.source === "outrank" || row.source === "crawlproof"
      ? row.source
      : "static") as Post["source"],
    image_url: row.image_url,
  };
}

// Pull autoblog-ingested posts from blog_posts. Newest first. Returns
// [] if the DB isn't reachable so the blog page degrades gracefully
// to the static array above.
export async function loadDbPosts(): Promise<Post[]> {
  try {
    const sb = serviceClient();
    const { data, error } = await sb
      .from("blog_posts")
      .select(
        "slug, title, meta_description, content_html, content_markdown, image_url, published_at, source_created_at, source",
      )
      .order("published_at", { ascending: false })
      .limit(200);
    if (error || !data) return [];
    return data.map(rowToPost);
  } catch {
    return [];
  }
}

// Merge static + DB posts, dedup by slug (DB wins if both exist), sort
// by date desc. This is the source-of-truth for the marketing blog
// listing.
export async function loadAllPosts(): Promise<Post[]> {
  const db = await loadDbPosts();
  const bySlug = new Map<string, Post>();
  for (const p of posts) bySlug.set(p.slug, p);
  for (const p of db) bySlug.set(p.slug, p);
  return [...bySlug.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
}

export async function findAnyPost(slug: string): Promise<Post | undefined> {
  const fromStatic = findPost(slug);
  if (fromStatic) return fromStatic;
  try {
    const sb = serviceClient();
    const { data } = await sb
      .from("blog_posts")
      .select(
        "slug, title, meta_description, content_html, content_markdown, image_url, published_at, source_created_at, source",
      )
      .eq("slug", slug)
      .maybeSingle();
    if (!data) return undefined;
    return rowToPost(data as BlogPostRow);
  } catch {
    return undefined;
  }
}
