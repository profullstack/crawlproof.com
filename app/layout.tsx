import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"),
  title: {
    default: "CrawlProof — See your site the way AI crawlers do.",
    template: "%s · CrawlProof",
  },
  description:
    "CrawlProof runs an AEO audit on any URL and reports what LLM crawlers and answer engines can actually find — content, schema, robots rules, AI-bot access, and positioning.",
  openGraph: {
    title: "CrawlProof",
    description: "See your site the way AI crawlers do.",
    type: "website",
    siteName: "CrawlProof",
  },
  twitter: { card: "summary_large_image", title: "CrawlProof" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body>
        {children}
        <Script
          src="https://datafa.st/js/script.js"
          data-website-id="dfid_8BKVGnR966rQYogyWQoI8"
          data-domain="crawlproof.com"
          strategy="afterInteractive"
        />
      </body>
    </html>
  );
}
