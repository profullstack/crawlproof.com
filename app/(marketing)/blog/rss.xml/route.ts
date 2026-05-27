import { buildRssXml } from "@profullstack/autoblog/feeds";
import { env } from "@/lib/env";
import { loadAllPosts } from "@/lib/blog/posts";

// Match the blog index revalidate so the feed reflects new posts
// within a minute of an autoblog webhook landing.
export const revalidate = 60;

export async function GET() {
  const posts = await loadAllPosts();
  const xml = buildRssXml({
    title: "CrawlProof blog",
    description:
      "Notes on AEO, AI crawlers, schema, llms.txt, and how AI answer engines pick what to cite.",
    siteUrl: env.siteUrl.replace(/\/$/, ""),
    posts: posts.map((p) => ({
      slug: p.slug,
      title: p.title,
      publishedAt: p.date,
      excerpt: p.excerpt,
      html: p.html ?? null,
      imageUrl: p.image_url ?? null,
    })),
  });
  return new Response(xml, {
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      "cache-control": "public, max-age=60, s-maxage=60",
    },
  });
}
