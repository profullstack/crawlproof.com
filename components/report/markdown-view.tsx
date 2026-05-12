import { markdownToHtml } from "@/lib/markdown";

export async function MarkdownView({ markdown }: { markdown: string }) {
  const html = await markdownToHtml(markdown);
  return (
    <article
      className="card prose max-w-none p-6 [&_a]:underline [&_h1]:mt-0 [&_h1]:text-3xl [&_h1]:font-extrabold [&_h2]:mt-8 [&_h2]:border-t [&_h2]:border-[var(--color-border)] [&_h2]:pt-6 [&_h2]:text-xl [&_h2]:font-bold [&_h3]:mt-4 [&_h3]:font-semibold [&_hr]:my-8 [&_hr]:border-[var(--color-border)] [&_li]:my-1 [&_p]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-[var(--color-bg)] [&_pre]:p-3 [&_pre]:text-xs [&_table]:my-4 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-[var(--color-border)] [&_td]:px-3 [&_td]:py-2 [&_td]:text-sm [&_th]:border [&_th]:border-[var(--color-border)] [&_th]:bg-[var(--color-bg)] [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:text-xs [&_th]:uppercase [&_th]:text-[var(--color-muted)] [&_ul]:list-disc [&_ul]:pl-6"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
