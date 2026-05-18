import { env } from "@/lib/env";

// Fire-and-forget call to the worker. Falls back silently if the worker
// URL isn't configured — the worker's polling sweep is the safety net.

export async function enqueueSitemapCrawl(siteId: string): Promise<void> {
  await postToWorker("/lx/sitemap-crawl", { siteId });
}

export async function enqueueKeywordResearch(siteId: string): Promise<void> {
  await postToWorker("/lx/keywords-research", { siteId });
}

export async function enqueueArticleGenerate(
  siteId: string,
  opts: { preview?: boolean } = {},
): Promise<void> {
  await postToWorker("/lx/article-generate", { siteId, preview: !!opts.preview });
}

export async function enqueueArticleDeliver(articleId: string): Promise<void> {
  await postToWorker("/lx/article-deliver", { articleId });
}

async function postToWorker(path: string, body: unknown): Promise<void> {
  if (!env.workerUrl) return;
  try {
    await fetch(`${env.workerUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-worker-secret": env.workerSecret,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.warn(`[lx] worker notify ${path} failed`, err);
  }
}
