// Child-process entry for the link crawl. Forked by links-engine.ts.
//
// Contract: argv[2] is the target URL, argv[3] an optional per-link timeout in
// ms (tests use a short one to make the abort race deterministic). We print
// exactly one JSON object to stdout and exit 0. Anything else on stdout would
// corrupt the parse, so all diagnostics go to stderr (which the parent forwards
// to the worker log).
//
// This process is expendable by design — see the comment in links-crawl.ts for
// why linkinator can hard-exit the process it runs in. Both exit paths salvage
// whatever the accumulator holds, so a crash 200 pages into a crawl still
// reports those 200 pages instead of losing the audit.

import { crawlLinks, newAccumulator, type CrawlAccumulator } from "./links-crawl";

export type ChildReport = {
  acc: CrawlAccumulator;
  /** Set when the crawl ended early; the parent turns this into a warn finding. */
  crashed: string | null;
};

const acc = newAccumulator();
let emitted = false;

function emit(crashed: string | null): void {
  if (emitted) return; // an uncaught error while shutting down must not double-print
  emitted = true;
  const report: ChildReport = { acc, crashed };
  process.stdout.write(JSON.stringify(report), () => process.exit(0));
  // linkinator leaves sockets open, so the natural exit may never come; and if
  // stdout's drain callback is itself lost, exit anyway rather than hang the
  // parent until its kill timer fires.
  setTimeout(() => process.exit(0), 2_000).unref();
}

// An unhandled 'error' event on a Readable arrives here as an uncaught
// exception. This handler is the whole point of the child process: catch it,
// keep the partial crawl, and leave the parent worker untouched.
process.on("uncaughtException", (err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[links-crawl] uncaught in crawl child: ${message}`);
  emit(message);
});
process.on("unhandledRejection", (err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[links-crawl] unhandled rejection in crawl child: ${message}`);
  emit(message);
});

const target = process.argv[2];
if (!target) {
  console.error("[links-crawl] no target URL argument");
  process.exit(2);
}

const perLinkTimeoutMs = Number(process.argv[3]) || undefined;

crawlLinks(target, acc, { perLinkTimeoutMs }).then(
  () => emit(null),
  (err: unknown) => emit(err instanceof Error ? err.message : String(err)),
);
