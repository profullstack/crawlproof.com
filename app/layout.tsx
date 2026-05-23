import type { Metadata, Viewport } from "next";
import Script from "next/script";
import "./globals.css";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  // iOS Safari shows the address bar in this color when the PWA is installed.
  themeColor: "#0b0d10",
  colorScheme: "dark",
};

const SITE_TITLE = "CrawlProof — See your site the way AI crawlers do.";
const SITE_DESC =
  "CrawlProof runs an AEO audit on any URL and reports what LLM crawlers and answer engines can actually find — content, schema, robots rules, AI-bot access, and positioning.";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"),
  title: { default: SITE_TITLE, template: "%s · CrawlProof" },
  description: SITE_DESC,
  alternates: { canonical: "/" },
  openGraph: {
    title: SITE_TITLE,
    description: SITE_DESC,
    type: "website",
    siteName: "CrawlProof",
    url: "/",
    locale: "en_US",
    images: [{ url: "/banner.png", width: 1200, height: 630, alt: "CrawlProof" }],
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_TITLE,
    description: SITE_DESC,
    images: ["/banner.png"],
  },
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/favicon-16.png", sizes: "16x16", type: "image/png" },
    ],
    shortcut: "/icons/favicon.ico",
    apple: [
      { url: "/icons/apple-touch-icon-180x180.png", sizes: "180x180" },
      { url: "/icons/apple-touch-icon-152x152.png", sizes: "152x152" },
      { url: "/icons/apple-touch-icon-144x144.png", sizes: "144x144" },
      { url: "/icons/apple-touch-icon-120x120.png", sizes: "120x120" },
      { url: "/icons/apple-touch-icon-114x114.png", sizes: "114x114" },
      { url: "/icons/apple-touch-icon-76x76.png", sizes: "76x76" },
      { url: "/icons/apple-touch-icon-72x72.png", sizes: "72x72" },
      { url: "/icons/apple-touch-icon-60x60.png", sizes: "60x60" },
      { url: "/icons/apple-touch-icon-57x57.png", sizes: "57x57" },
    ],
  },
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "CrawlProof",
  },
};

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://crawlproof.com";

// Structured data — gives Google's brand panel, AI engines, and sitelinks
// searchbox real entities to attach to instead of guessing from <title>.
const JSON_LD = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebSite",
      "@id": `${SITE_URL}#website`,
      url: SITE_URL,
      name: "CrawlProof",
      description: SITE_DESC,
      publisher: { "@id": `${SITE_URL}#org` },
      potentialAction: {
        "@type": "SearchAction",
        target: {
          "@type": "EntryPoint",
          urlTemplate: `${SITE_URL}/?url={search_term_string}`,
        },
        "query-input": "required name=search_term_string",
      },
      inLanguage: "en-US",
    },
    {
      "@type": "Organization",
      "@id": `${SITE_URL}#org`,
      name: "CrawlProof",
      url: SITE_URL,
      logo: `${SITE_URL}/icon`,
      sameAs: [],
    },
    {
      "@type": "SoftwareApplication",
      "@id": `${SITE_URL}#app`,
      name: "CrawlProof",
      applicationCategory: "BusinessApplication",
      operatingSystem: "Web",
      url: SITE_URL,
      description: SITE_DESC,
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body>
        <script
          type="application/ld+json"
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }}
        />
        {children}
        <Script
          src="https://datafa.st/js/script.js"
          data-website-id="dfid_8BKVGnR966rQYogyWQoI8"
          data-domain="crawlproof.com"
          strategy="afterInteractive"
        />
        {/* Robauto.ai — A.I. Growth Engine Pixel */}
        <Script id="robauto-pixel" strategy="afterInteractive">
          {`(function(){
  var pid="5b1ee9c4-5877-43cd-91e8-01406011bf83";
  var ep="https://hkeytqaukllckucnhzey.supabase.co/functions/v1/track";
  var d=JSON.stringify({path:location.pathname,url:location.href,referer:document.referrer});
  if(navigator.sendBeacon){navigator.sendBeacon(ep+"?pid="+pid,d)}
  else{var x=new XMLHttpRequest();x.open("POST",ep+"?pid="+pid);x.setRequestHeader("Content-Type","application/json");x.send(d)}
})();`}
        </Script>
              <Script data-site="dcd27dec-b0b4-4f2c-a5b6-09839edc153e" src="https://crawlproof.com/stats.js" strategy="afterInteractive" />
      </body>
    </html>
  );
}
