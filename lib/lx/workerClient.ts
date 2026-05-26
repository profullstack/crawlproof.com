import { env } from "@/lib/env";

// Fire-and-forget call to the worker. Callers get an explicit result so
// manual UI actions can show whether the worker accepted the job.

export type WorkerEnqueueResult =
  | { ok: true }
  | { ok: false; error: string };

export async function enqueueSitemapCrawl(
  siteId: string,
): Promise<WorkerEnqueueResult> {
  return postToWorker("/lx/sitemap-crawl", { siteId });
}

export async function enqueueKeywordResearch(
  siteId: string,
): Promise<WorkerEnqueueResult> {
  return postToWorker("/lx/keywords-research", { siteId });
}

export async function enqueueArticleGenerate(
  siteId: string,
  opts: { preview?: boolean; manual?: boolean } = {},
): Promise<WorkerEnqueueResult> {
  return postToWorker("/lx/article-generate", {
    siteId,
    preview: !!opts.preview,
    manual: !!opts.manual,
  });
}

export async function enqueueArticleDeliver(
  articleId: string,
): Promise<WorkerEnqueueResult> {
  return postToWorker("/lx/article-deliver", { articleId });
}

export async function enqueueGuestPostGenerate(
  authorSiteId: string,
  targetSiteId: string,
  topic: string,
  opts: { preview?: boolean; requestId?: string } = {},
): Promise<WorkerEnqueueResult> {
  return postToWorker("/lx/guest-post-generate", {
    authorSiteId,
    targetSiteId,
    topic,
    preview: !!opts.preview,
    requestId: opts.requestId,
  });
}

async function postToWorker(
  path: string,
  body: unknown,
): Promise<WorkerEnqueueResult> {
  if (!env.workerUrl) {
    return { ok: false, error: "Worker is not configured (WORKER_URL missing)." };
  }
  try {
    const res = await fetch(`${env.workerUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-worker-secret": env.workerSecret,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        ok: false,
        error: `Worker rejected ${path} with ${res.status}${text ? `: ${text}` : ""}.`,
      };
    }
    return { ok: true };
  } catch (err) {
    console.warn(`[lx] worker notify ${path} failed`, err);
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
