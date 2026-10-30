import type { Metadata } from "next";
import { env } from "@/lib/env";

export type SeoAeoMetaInput = {
  title: string;
  description: string;
  url?: string;
  siteName?: string;
  type?: "website" | "article";
  robots?: Metadata["robots"];
  socialCard?: "summary" | "summary_large_image";
  image?: string;
  imageAlt?: string;
  publishedTime?: string;
  modifiedTime?: string;
};

/** Shared server-rendered SEO and social metadata for CrawlProof share pages. */
export function createSeoAeoMetadata(input: SeoAeoMetaInput): Metadata {
  const title = input.title.trim().slice(0, 180);
  const description = input.description.trim().replace(/\s+/g, " ").slice(0, 300);
  const image = input.image ? { url: input.image, ...(input.imageAlt ? { alt: input.imageAlt } : {}) } : undefined;
  const openGraph = input.type === "article"
    ? {
        type: "article" as const,
        title,
        description,
        siteName: input.siteName ?? "CrawlProof",
        ...(input.url ? { url: input.url } : {}),
        ...(input.publishedTime ? { publishedTime: input.publishedTime } : {}),
        ...(input.modifiedTime ? { modifiedTime: input.modifiedTime } : {}),
        ...(image ? { images: [image] } : {}),
      }
    : {
        type: "website" as const,
        title,
        description,
        siteName: input.siteName ?? "CrawlProof",
        ...(input.url ? { url: input.url } : {}),
        ...(image ? { images: [image] } : {}),
      };

  return {
    metadataBase: new URL(env.siteUrl),
    title,
    description,
    ...(input.url ? { alternates: { canonical: input.url } } : {}),
    ...(input.robots ? { robots: input.robots } : {}),
    openGraph,
    twitter: {
      card: input.socialCard ?? (image ? "summary_large_image" : "summary"),
      title,
      description,
      ...(image ? { images: [image.url] } : {}),
    },
  };
}

/** Escape JSON-LD before embedding user-authored metadata in a script element. */
export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
