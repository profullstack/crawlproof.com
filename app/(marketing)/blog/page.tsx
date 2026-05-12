import Link from "next/link";
import { posts } from "@/lib/blog/posts";

export const metadata = { title: "Blog" };

export default function BlogIndex() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-4xl font-extrabold">Blog</h1>
      <p className="mt-2 text-[var(--color-muted)]">
        Notes on AEO, AI crawlers, and how to make sites legible to LLMs.
      </p>
      <ul className="mt-10 space-y-6">
        {posts.map((p) => (
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
