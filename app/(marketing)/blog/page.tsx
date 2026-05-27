import Link from "next/link";
import { loadAllPosts } from "@/lib/blog/posts";

export const metadata = {
  title: "Blog",
  description:
    "Notes on AEO, LLM crawlers, schema markup, llms.txt, and how AI answer engines actually pick what to cite — from the team building CrawlProof.",
  alternates: {
    canonical: "/blog",
    types: { "application/rss+xml": "/blog/rss.xml" },
  },
  openGraph: {
    title: "CrawlProof blog",
    description:
      "Notes on AEO, LLM crawlers, schema, llms.txt, and how AI answer engines pick what to cite.",
    url: "/blog",
  },
};

// ISR — blog ingest fires asynchronously via /api/webhooks/{outrank,crawlproof};
// 60s is small enough that newly-published posts surface quickly.
export const revalidate = 60;

export default async function BlogIndex() {
  const all = await loadAllPosts();
  return (
    <main className="mx-auto max-w-3xl px-4 sm:px-6 py-16">
      <h1 className="text-4xl font-extrabold">Blog</h1>
      <p className="mt-2 text-[var(--color-muted)]">
        Notes on AEO, AI crawlers, and how to make sites legible to LLMs.
      </p>
      <ul className="mt-10 space-y-6">
        {all.map((p) => (
          <li key={p.slug} className="card overflow-hidden p-0">
            <Link
              href={`/blog/${p.slug}`}
              className="flex gap-4 p-4 sm:gap-5 sm:p-5"
            >
              {/* Thumbnail. Falls back to a tinted "CP" placeholder so the
               * list column stays aligned even when an autoblog post lands
               * without a featured image. */}
              {p.image_url ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={p.image_url}
                  alt=""
                  loading="lazy"
                  width={120}
                  height={120}
                  className="h-20 w-20 shrink-0 rounded-md object-cover sm:h-28 sm:w-28"
                />
              ) : (
                <div
                  aria-hidden
                  className="flex h-20 w-20 shrink-0 items-center justify-center rounded-md bg-[var(--color-card)] text-xs font-semibold uppercase tracking-wider text-[var(--color-accent)] sm:h-28 sm:w-28"
                >
                  CP
                </div>
              )}
              <div className="min-w-0 flex-1">
                <h2 className="text-lg font-bold leading-snug sm:text-xl">{p.title}</h2>
                <p className="mt-1 text-xs text-[var(--color-muted)] sm:text-sm">
                  {p.date}
                </p>
                {p.excerpt && (
                  <p className="mt-2 line-clamp-2 text-sm text-[var(--color-muted)]">
                    {p.excerpt}
                  </p>
                )}
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
