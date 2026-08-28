import { env } from "@/lib/env";
import { ANON_DAILY_SCANS, CREDIT_PACKS, SIGNUP_CREDITS } from "@/lib/credits";

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
              `${ANON_DAILY_SCANS} anonymous audits/day per IP, plus ${SIGNUP_CREDITS} free credits on signup.`,
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
