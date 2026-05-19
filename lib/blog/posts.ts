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

// Static, hand-written posts. Kept here so the blog never depends on
// the DB for its first articles, and so a fresh deploy has content.
export const posts: Post[] = [
  {
    slug: "what-is-aeo",
    title: "What is AEO, and why it isn't SEO",
    date: "2026-05-01",
    excerpt:
      "Answer Engine Optimization is the new top of funnel. Here's the short version.",
    source: "static",
    body: `Answer Engine Optimization (AEO) is the practice of making your content findable
and citable by LLM-powered answer engines: ChatGPT, Claude, Perplexity, Google AI Overviews.
The constraints overlap with SEO — clean HTML, sitemap, schema — but they diverge in the
details. AEO cares about JS-rendering (LLMs see less than headless browsers), about
explicit AI-bot rules in robots.txt, and about new files like llms.txt and skill.md.`,
  },
  {
    slug: "llms-txt-and-skill-md",
    title: "llms.txt and skill.md, explained",
    date: "2026-05-08",
    excerpt:
      "Two new files AI crawlers look for. What they are, what to put in them.",
    source: "static",
    body: `llms.txt is a public summary of your site for LLMs — concise, link-rich, structured.
skill.md is a per-host description of capabilities an AI agent can use. Together they help
LLMs understand what your site is for without having to crawl every page.`,
  },
];

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
  source: string;
};

function rowToPost(row: BlogPostRow): Post {
  return {
    slug: row.slug,
    title: row.title,
    date: row.published_at.slice(0, 10),
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
        "slug, title, meta_description, content_html, content_markdown, image_url, published_at, source",
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
        "slug, title, meta_description, content_html, content_markdown, image_url, published_at, source",
      )
      .eq("slug", slug)
      .maybeSingle();
    if (!data) return undefined;
    return rowToPost(data as BlogPostRow);
  } catch {
    return undefined;
  }
}
