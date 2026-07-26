import { ImageResponse } from "next/og";

// Static card for the /slop landing page. No data fetch, so Next generates it
// once at build time.

export const alt = "Slop Score — free carelessness scan for your site";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const BG = "#0b0d10";
const FG = "#e7e9ee";
const MUTED = "#9aa3b2";
const BORDER = "#1f2630";
const ACCENT = "#6ee7b7";
const WARN = "#fbbf24";
const FAIL = "#f87171";

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: BG,
          padding: "64px 72px",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", fontSize: 26, fontWeight: 700, letterSpacing: 6, color: ACCENT }}>
            CRAWLPROOF
          </div>
          <div style={{ display: "flex", fontSize: 26, color: MUTED, letterSpacing: 2 }}>
            FREE · NO SIGNUP
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", fontSize: 88, fontWeight: 800, color: FG, lineHeight: 1.05 }}>
            Find the careless
          </div>
          <div style={{ display: "flex", fontSize: 88, fontWeight: 800, color: FG, lineHeight: 1.05 }}>
            mistakes on your site.
          </div>
          <div style={{ display: "flex", fontSize: 32, color: MUTED, marginTop: 26 }}>
            Sweeps up to 50 pages for observable defects — content, code, design.
          </div>

          {/* The banded dial, matching the page: 0 pristine → 100 maximum slop. */}
          <div style={{ display: "flex", width: "100%", height: 16, borderRadius: 999, marginTop: 34, background: BORDER }}>
            <div style={{ display: "flex", width: "25%", height: "100%", borderRadius: "999px 0 0 999px", background: ACCENT }} />
            <div style={{ display: "flex", width: "25%", height: "100%", background: WARN }} />
            <div style={{ display: "flex", width: "50%", height: "100%", borderRadius: "0 999px 999px 0", background: FAIL }} />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 24, color: MUTED, marginTop: 14 }}>
            <div style={{ display: "flex" }}>0 — pristine</div>
            <div style={{ display: "flex" }}>100 — maximum slop</div>
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", fontSize: 26, color: MUTED }}>
            Not an AI-detector — observable defects only
          </div>
          <div style={{ display: "flex", fontSize: 26, color: ACCENT }}>crawlproof.com/slop</div>
        </div>
      </div>
    ),
    size,
  );
}
