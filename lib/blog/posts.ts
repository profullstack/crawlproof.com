export type Post = {
  slug: string;
  title: string;
  date: string;
  excerpt: string;
  body: string;
};

export const posts: Post[] = [
  {
    slug: "what-is-aeo",
    title: "What is AEO, and why it isn't SEO",
    date: "2026-05-01",
    excerpt: "Answer Engine Optimization is the new top of funnel. Here's the short version.",
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
    excerpt: "Two new files AI crawlers look for. What they are, what to put in them.",
    body: `llms.txt is a public summary of your site for LLMs — concise, link-rich, structured.
skill.md is a per-host description of capabilities an AI agent can use. Together they help
LLMs understand what your site is for without having to crawl every page.`,
  },
];

export function findPost(slug: string) {
  return posts.find((p) => p.slug === slug);
}
