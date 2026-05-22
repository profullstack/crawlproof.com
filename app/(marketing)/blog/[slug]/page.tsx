import { notFound } from "next/navigation";
import { findAnyPost, posts } from "@/lib/blog/posts";
import { env } from "@/lib/env";

// ISR. Static posts are prerendered via generateStaticParams; DB-backed
// posts fall through to on-demand render and are cached for 60s.
export const revalidate = 60;
export const dynamicParams = true;

export async function generateStaticParams() {
  return posts.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const post = await findAnyPost(slug);
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
      images: post.image_url ? [{ url: post.image_url }] : undefined,
    },
  };
}

export default async function BlogPost({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const post = await findAnyPost(slug);
  if (!post) notFound();

  return (
    <main className="mx-auto max-w-3xl px-4 sm:px-6 py-16">
      <a
        href="/blog"
        className="inline-flex items-center text-sm text-[var(--color-muted)] hover:text-[var(--color-accent)]"
      >
        ← Back to posts
      </a>
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
            image: post.image_url ? [post.image_url] : undefined,
          }),
        }}
      />
      <p className="text-sm text-[var(--color-muted)]">{post.date}</p>
      <h1 className="mt-2 text-4xl font-extrabold">{post.title}</h1>
      {post.image_url && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={post.image_url}
          alt=""
          className="mt-6 w-full rounded-lg border border-[var(--color-border)]"
        />
      )}
      {post.html ? (
        <article
          className="prose prose-invert mt-6 max-w-none text-[var(--color-fg)] [&_a]:underline [&_h2]:mt-8 [&_h2]:text-2xl [&_h2]:font-bold [&_h3]:mt-6 [&_h3]:text-xl [&_h3]:font-semibold [&_p]:mt-4 [&_ul]:mt-4 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:mt-4 [&_ol]:list-decimal [&_ol]:pl-6 [&_blockquote]:mt-4 [&_blockquote]:border-l-4 [&_blockquote]:border-[var(--color-border)] [&_blockquote]:pl-4 [&_blockquote]:italic [&_img]:my-6 [&_img]:rounded-lg [&_pre]:mt-4 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:border [&_pre]:border-[var(--color-border)] [&_pre]:bg-[var(--color-card)] [&_pre]:p-3 [&_code]:rounded [&_code]:bg-[var(--color-card)] [&_code]:px-1.5 [&_code]:py-0.5 [&_table]:my-4 [&_th]:border [&_th]:border-[var(--color-border)] [&_th]:px-2 [&_th]:py-1 [&_td]:border [&_td]:border-[var(--color-border)] [&_td]:px-2 [&_td]:py-1"
          dangerouslySetInnerHTML={{ __html: post.html }}
        />
      ) : (
        <article className="mt-6 whitespace-pre-line text-lg text-[var(--color-fg)]">
          {post.body}
        </article>
      )}
    </main>
  );
}
