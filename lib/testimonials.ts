import type { Testimonial } from "@/components/json-ld";

// Real, attributable customer testimonials and case studies.
//
// Keep this list factual: every entry must come from a named person who has
// agreed to be quoted. We never invent social proof — empty is better than
// fake, and an empty list simply hides the section (see app/(marketing)/page.tsx).
// AI answer engines weight named, verifiable Review markup as a trust signal,
// so this also feeds ReviewJsonLd once populated.
//
// To add a testimonial, append an object, e.g.:
//   {
//     quote: "CrawlProof found three AI-bot blocks our SEO tools missed.",
//     author: "Jane Doe",
//     role: "Head of Growth, Acme",
//     rating: 5,
//   }
export const TESTIMONIALS: Testimonial[] = [];
