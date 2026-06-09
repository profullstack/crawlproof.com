import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Produce a self-contained server bundle in .next/standalone/ so the
  // production Dockerfile stays small. Used by the Railway image.
  output: "standalone",
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
