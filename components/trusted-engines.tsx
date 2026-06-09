"use client";

import { usePathname } from "next/navigation";

const engines = [
  "OpenAI · ChatGPT",
  "Anthropic · Claude",
  "Perplexity",
  "Google AI Overviews",
  "Gemini",
  "Apple Intelligence",
];

// Honest social proof: CrawlProof doesn't publish customer logos, but its
// credibility rests on being tuned for the answer engines that decide what
// gets cited. This logo strip surfaces those recognizable brands. Rendered
// from the marketing layout but scoped to the homepage only.
export function TrustedEngines() {
  const pathname = usePathname();
  if (pathname !== "/") return null;

  return (
    <section
      aria-label="Answer engines CrawlProof audits for"
      className="mx-auto max-w-5xl px-4 sm:px-6 pb-12"
    >
      <p className="mb-5 text-center text-xs font-medium uppercase tracking-wider text-[var(--color-muted)]">
        Tuned for the answer engines that decide what gets cited
      </p>
      <ul className="flex flex-wrap items-center justify-center gap-x-3 gap-y-3 sm:gap-x-4">
        {engines.map((name) => (
          <li
            key={name}
            className="rounded-full border border-[var(--color-border)] bg-[var(--color-card)] px-4 py-2 text-sm font-semibold text-[var(--color-fg)]"
          >
            {name}
          </li>
        ))}
      </ul>
    </section>
  );
}
