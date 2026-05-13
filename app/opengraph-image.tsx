import { ImageResponse } from "next/og";

// Next.js convention: this file becomes /opengraph-image — a 1200x630 PNG
// served as og:image for any route that doesn't define its own. Generated
// dynamically by @vercel/og so we don't ship a static asset.

export const runtime = "edge";
export const alt = "CrawlProof — See your site the way AI crawlers do.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OG() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "80px 80px 64px",
          background:
            "linear-gradient(135deg, #0b0d10 0%, #0f1a17 55%, #062b22 100%)",
          color: "#f8fafc",
          fontFamily: "Inter, system-ui, sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 14,
              background: "#059669",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 32,
              fontWeight: 800,
              color: "#0b0d10",
              letterSpacing: -1,
            }}
          >
            C
          </div>
          <div
            style={{
              fontSize: 28,
              fontWeight: 700,
              letterSpacing: -0.5,
            }}
          >
            CrawlProof
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div
            style={{
              fontSize: 76,
              fontWeight: 800,
              lineHeight: 1.05,
              letterSpacing: -2,
              maxWidth: 980,
            }}
          >
            See your site the way AI crawlers do.
          </div>
          <div
            style={{
              fontSize: 28,
              color: "#94a3b8",
              lineHeight: 1.35,
              maxWidth: 920,
            }}
          >
            AEO audits for LLM crawlers and answer engines — content,
            schema, robots rules, AI-bot access, and positioning.
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            fontSize: 22,
            color: "#64748b",
          }}
        >
          <span
            style={{
              padding: "6px 14px",
              borderRadius: 999,
              background: "#059669",
              color: "#0b0d10",
              fontWeight: 700,
            }}
          >
            Free scan
          </span>
          <span>crawlproof.com</span>
        </div>
      </div>
    ),
    { ...size },
  );
}
