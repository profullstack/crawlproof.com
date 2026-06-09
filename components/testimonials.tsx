import { ReviewJsonLd } from "@/components/json-ld";
import { TESTIMONIALS } from "@/lib/testimonials";

// Social-proof section for the marketing homepage. Renders nothing until at
// least one real, attributable testimonial exists in lib/testimonials.ts, so
// the page never ships invented customer quotes. When populated it also emits
// Review / AggregateRating JSON-LD via ReviewJsonLd for AI citation trust.
export function Testimonials() {
  if (TESTIMONIALS.length === 0) return null;

  return (
    <section className="mx-auto max-w-6xl px-4 sm:px-6 pb-16">
      <ReviewJsonLd testimonials={TESTIMONIALS} />
      <h2 className="mb-2 text-center text-2xl font-bold">What customers say</h2>
      <p className="mx-auto mb-8 max-w-2xl text-center text-sm text-[var(--color-muted)]">
        Real results from teams using CrawlProof to fix what AI crawlers and answer
        engines see.
      </p>
      <div className="grid gap-4 md:grid-cols-3">
        {TESTIMONIALS.map((t) => (
          <figure key={`${t.author}-${t.quote.slice(0, 24)}`} className="card flex flex-col p-5">
            <blockquote className="text-sm text-[var(--color-fg)]">
              &ldquo;{t.quote}&rdquo;
            </blockquote>
            <figcaption className="mt-4 text-xs text-[var(--color-muted)]">
              <span className="font-semibold text-[var(--color-fg)]">{t.author}</span>
              {t.role ? <> — {t.role}</> : null}
            </figcaption>
          </figure>
        ))}
      </div>
    </section>
  );
}
