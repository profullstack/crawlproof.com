import { notFound } from "next/navigation";
import { findPost, posts } from "@/lib/blog/posts";
import { env } from "@/lib/env";

export async function generateStaticParams() {
  return posts.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const post = findPost(slug);
  if (!post) {
    return { title: "Post not found", alternates: { canonical: `/blog/${slug}` } };
  }
  return {
    title: post.title,
    description: post.excerpt ?? undefined,
    alternates: { canonical: `/blog/${slug}` },
    openGraph: {
      type: "article",
      url: `/blog/${slug}`,
      title: post.title,
      description: post.excerpt ?? undefined,
    },
  };
}

export default async function BlogPost({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const post = findPost(slug);
  if (!post) notFound();

  return (
    <main className="mx-auto max-w-3xl px-4 sm:px-6 py-16">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "BlogPosting",
            headline: post.title,
            datePublished: post.date,
            author: { "@type": "Organization", name: "CrawlProof" },
            mainEntityOfPage: `${env.siteUrl}/blog/${post.slug}`,
          }),
        }}
      />
      <p className="text-sm text-[var(--color-muted)]">{post.date}</p>
      <h1 className="mt-2 text-4xl font-extrabold">{post.title}</h1>
      <article className="mt-6 whitespace-pre-line text-lg text-[var(--color-fg)]">
        {post.body}
      </article>
    </main>
  );
}
