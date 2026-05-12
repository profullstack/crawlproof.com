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
      </body>
    </html>
  );
}
