// Global cap on concurrently running headless Chromium instances.
//
// Each browser-automated post (see platforms/browser.ts) spins up its own
// Chromium. Firing many at once — e.g. an outreach "post to all" that hits the
// worker's /sp/browser-post endpoint once per account — launched them all in
// parallel and exhausted the process thread limit, so every launch died with
//   pthread_create: Resource temporarily unavailable (11)
//   FATAL: Failed to start BrowserThread:IO
// This semaphore serializes launches down to a small ceiling; extra posts wait
// their turn instead of crashing. The slot is held for the whole lifetime of a
// browser (launch → close), so it caps *running* browsers, not just launches.
//
// Tune with SP_BROWSER_CONCURRENCY (default 2). It's a module singleton, so the
// cap is shared across every post handled by a given worker process.

export class AsyncSemaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(max: number) {
    this.available = Math.max(1, Math.floor(max));
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      // Hand the slot straight to the next waiter — never over-issue.
      next();
    } else {
      this.available += 1;
    }
  }

  // Acquire, run fn, and always release — even if fn throws.
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

function configuredMax(): number {
  const raw = Number(process.env.SP_BROWSER_CONCURRENCY);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 2;
}

export const browserSemaphore = new AsyncSemaphore(configuredMax());
