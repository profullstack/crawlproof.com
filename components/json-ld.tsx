import { env } from "@/lib/env";
import { CREDIT_PACKS } from "@/lib/credits";

function Tag({ data }: { data: unknown }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}

// Authoritative external profiles for knowledge graph anchoring.
// Keep in sync with the SAME_AS constant in app/layout.tsx.
const SAME_AS = [
  "https://github.com/profullstack/crawlproof.com",
  "https://www.linkedin.com/company/crawlproof",
  "https://www.crunchbase.com/organization/crawlproof",
];

export function OrganizationJsonLd() {
  return (
    <Tag
      data={{
        "@context": "https://schema.org",
        "@type": "Organization",
        name: "CrawlProof",
        url: env.siteUrl,
        logo: `${env.siteUrl}/icon.png`,
        sameAs: SAME_AS,
      }}
    />
  );
}

export function SoftwareApplicationJsonLd() {
  return (
    <Tag
      data={{
        "@context": "https://schema.org",
        "@type": "SoftwareApplication",
        name: "CrawlProof",
        applicationCategory: "BusinessApplication",
        operatingSystem: "Web",
        description:
          "AEO auditor — fetches any URL, checks how LLM crawlers and answer engines see it (content, schema, robots, AI-bot rules, llms.txt, positioning) and produces a prioritized to-do list.",
        offers: [
          {
            "@type": "Offer",
            name: "Free scan",
            price: "0",
            priceCurrency: "USD",
            description:
              "10 anonymous audits/day per IP, plus 20 free credits on signup.",
          },
          // Real catalog — pay-per-scan credit packs, no subscription tier.
          ...CREDIT_PACKS.map((p) => ({
            "@type": "Offer",
            name: p.label,
            price: (p.amountCents / 100).toFixed(2),
            priceCurrency: "USD",
            description: `${p.credits} scan${p.credits === 1 ? "" : "s"} · $${(p.amountCents / p.credits / 100).toFixed(2)}/scan`,
          })),
        ],
      }}
    />
  );
}

export function FaqJsonLd({ faqs }: { faqs: { q: string; a: string }[] }) {
  return (
    <Tag
      data={{
        "@context": "https://schema.org",
        "@type": "FAQPage",
        mainEntity: faqs.map((f) => ({
          "@type": "Question",
          name: f.q,
          acceptedAnswer: { "@type": "Answer", text: f.a },
        })),
      }}
    />
  );
}

export function BreadcrumbJsonLd({
  items,
}: {
  items: { name: string; url: string }[];
}) {
  return (
    <Tag
      data={{
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        itemListElement: items.map((it, i) => ({
          "@type": "ListItem",
          position: i + 1,
          name: it.name,
          item: it.url,
        })),
      }}
    />
  );
}

// Customer testimonial / case-study review. We only emit Review schema for
// real, attributable quotes — never invented copy — so the social-proof
// trust signal AI engines look for is backed by verifiable people.
export type Testimonial = {
  quote: string;
  author: string;
  // Optional company / role for stronger attribution.
  role?: string;
  // Optional 1–5 star rating supplied by the reviewer.
  rating?: number;
};

export function ReviewJsonLd({ testimonials }: { testimonials: Testimonial[] }) {
  if (testimonials.length === 0) return null;

  const ratings = testimonials
    .map((t) => t.rating)
    .filter((r): r is number => typeof r === "number");

  const reviews = testimonials.map((t) => ({
    "@type": "Review",
    reviewBody: t.quote,
    author: {
      "@type": "Person",
      name: t.author,
      ...(t.role ? { jobTitle: t.role } : {}),
    },
    ...(typeof t.rating === "number"
      ? {
          reviewRating: {
            "@type": "Rating",
            ratingValue: t.rating,
            bestRating: 5,
            worstRating: 1,
          },
        }
      : {}),
  }));

  return (
    <Tag
      data={{
        "@context": "https://schema.org",
        "@type": "Organization",
        name: "CrawlProof",
        url: env.siteUrl,
        review: reviews,
        ...(ratings.length > 0
          ? {
              aggregateRating: {
                "@type": "AggregateRating",
                ratingValue: (
                  ratings.reduce((sum, r) => sum + r, 0) / ratings.length
                ).toFixed(1),
                reviewCount: ratings.length,
                bestRating: 5,
                worstRating: 1,
              },
            }
          : {}),
      }}
    />
  );
}
