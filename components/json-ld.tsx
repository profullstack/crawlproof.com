import { env } from "@/lib/env";

function Tag({ data }: { data: unknown }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}

export function OrganizationJsonLd() {
  return (
    <Tag
      data={{
        "@context": "https://schema.org",
        "@type": "Organization",
        name: "CrawlProof",
        url: env.siteUrl,
        logo: `${env.siteUrl}/icon.png`,
        sameAs: [],
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
        offers: [
          {
            "@type": "Offer",
            name: "Free",
            price: "0",
            priceCurrency: "USD",
          },
          {
            "@type": "Offer",
            name: "Pro",
            price: "29",
            priceCurrency: "USD",
            billingDuration: "P1M",
          },
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
