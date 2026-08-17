import type { NextConfig } from "next";

// Top-level paths that used to serve the signed-in app and now live under
// /dashboard. `ads` is handled separately below — it kept its top-level path
// for the public marketing page.
const APP_ROUTE_PREFIXES = [
  "admin",
  "analytics",
  "audits",
  "autoblog",
  "github",
  "projects",
  "promote",
  "settings",
  "social",
] as const;

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Produce a self-contained server bundle in .next/standalone/ so the
  // production Dockerfile stays small. Used by the Railway image.
  output: "standalone",
  // Playwright launches a real Chromium binary and resolves it through its own
  // package layout, so bundling it into a server chunk breaks that lookup at
  // runtime. Keep it external and let Node require it from node_modules.
  // imapflow opens raw TLS sockets and resolves its own compiled deps at
  // runtime; bundling it breaks both. nodemailer is here for the same reason.
  serverExternalPackages: ["playwright", "playwright-core", "imapflow", "nodemailer"],
  experimental: {
    serverActions: {
      bodySizeLimit: "2mb",
    },
  },
  images: {
    remotePatterns: [{ protocol: "https", hostname: "**" }],
  },
  // Permanent redirect: www.crawlproof.com → crawlproof.com (308 preserves
  // the HTTP method and body, making it the correct choice for permanent moves
  // on non-GET requests as well as GET).
  async redirects() {
    return [
      {
        source: "/:path*",
        has: [{ type: "host", value: "www.crawlproof.com" }],
        destination: "https://crawlproof.com/:path*",
        permanent: true, // emits 308
      },
      // Signed-in UI moved under /dashboard so the top level belongs entirely
      // to public pages. These keep old bookmarks, emails already sent, and
      // links in past reports working.
      //
      // 307 rather than 308 on purpose: none of these are indexed (they all sat
      // behind a login), so there is no SEO to preserve, and a temporary
      // redirect stays reversible instead of being cached in browsers forever
      // if a top-level path is later wanted for a public page.
      ...APP_ROUTE_PREFIXES.flatMap((prefix) => [
        { source: `/${prefix}`, destination: `/dashboard/${prefix}`, permanent: false },
        {
          source: `/${prefix}/:path*`,
          destination: `/dashboard/${prefix}/:path*`,
          permanent: false,
        },
      ]),
      // /ads is the exception at both ends. The bare path is now the public
      // marketing page (it redirects signed-in visitors on its own), and
      // /ads/house/* is artwork in public/ — redirects run before the
      // filesystem, so a blanket /ads/:path* would 404 every house creative.
      {
        source: "/ads/:path((?!house/).*)",
        destination: "/dashboard/ads/:path",
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
