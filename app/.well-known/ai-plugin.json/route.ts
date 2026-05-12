import { env } from "@/lib/env";

export async function GET() {
  return Response.json({
    schema_version: "v1",
    name_for_human: "CrawlProof",
    name_for_model: "crawlproof",
    description_for_human: "See your site the way AI crawlers do.",
    description_for_model:
      "Run an AEO audit on any URL and receive a structured report covering crawlability, schema, robots, AI-bot rules, and positioning.",
    auth: { type: "none" },
    api: { type: "openapi", url: `${env.siteUrl}/openapi.yaml`, is_user_authenticated: false },
    logo_url: `${env.siteUrl}/icon.png`,
    contact_email: "hello@crawlproof.com",
    legal_info_url: `${env.siteUrl}/terms`,
  });
}
