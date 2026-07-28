import type { NextConfig } from "next";

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
    ];
  },
};

export default nextConfig;
