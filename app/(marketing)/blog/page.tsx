import Link from "next/link";
import { loadAllPosts } from "@/lib/blog/posts";

export const metadata = {
  title: "Blog",
  description:
    "Notes on AEO, LLM crawlers, schema markup, llms.txt, and how AI answer engines actually pick what to cite — from the team building CrawlProof.",
  alternates: { canonical: "/blog" },
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
          <li key={p.slug} className="card p-5">
            <Link href={`/blog/${p.slug}`} className="block">
              <h2 className="text-xl font-bold">{p.title}</h2>
              <p className="mt-1 text-sm text-[var(--color-muted)]">
                {p.date} · {p.excerpt}
              </p>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
