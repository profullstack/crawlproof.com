"use client";

import type { AdCreative } from "@/lib/ads/creative";
import { formatSpec } from "@/lib/ads/creative";

// Live React mirror of renderCreativeHtml (lib/ads/creative.ts). Kept visually
// in sync with the served HTML so the editor preview matches production.
export function AdPreview({ creative, scale = 1 }: { creative: AdCreative; scale?: number }) {
  const { w, h } = formatSpec(creative.format);
  const isLeaderboard = creative.format === "banner_728x90";
  const isMobile = creative.format === "banner_320x50";
  const row = isLeaderboard || isMobile;
  const showBody = !isMobile;

  const logo = creative.logoUrl ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={creative.logoUrl}
      alt=""
      style={{ height: isMobile ? 20 : 28, width: "auto", borderRadius: 4, flex: "0 0 auto" }}
    />
  ) : null;

  const cta = (
    <span
      style={{
        background: creative.accentColor,
        color: "#04121a",
        fontWeight: 600,
        borderRadius: 6,
        padding: isMobile ? "4px 8px" : "7px 12px",
        fontSize: isMobile ? 11 : 13,
        whiteSpace: "nowrap",
      }}
    >
      {creative.ctaText}
    </span>
  );

  const text = (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
      <div
        style={{
          fontWeight: 700,
          fontSize: isMobile ? 13 : isLeaderboard ? 16 : 18,
          lineHeight: 1.15,
          color: creative.fgColor,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: isMobile ? "nowrap" : undefined,
        }}
      >
        {creative.headline}
      </div>
      {showBody && (
        <div
          style={{
            fontSize: isLeaderboard ? 12 : 13,
            lineHeight: 1.3,
            color: creative.fgColor,
            opacity: 0.8,
          }}
        >
          {creative.body}
        </div>
      )}
    </div>
  );

  return (
    <div
      style={{
        width: w * scale,
        height: h * scale,
        flex: "0 0 auto",
      }}
    >
      <div
        style={{
          width: w,
          height: h,
          transform: scale === 1 ? undefined : `scale(${scale})`,
          transformOrigin: "top left",
          background: creative.bgColor,
          fontFamily: creative.fontFamily,
          borderRadius: 8,
          padding: isMobile ? "8px 10px" : 14,
          overflow: "hidden",
          border: "1px solid rgba(255,255,255,.08)",
          boxSizing: "border-box",
        }}
      >
        {row ? (
          <div style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", height: "100%" }}>
            {logo}
            {text}
            <div style={{ marginLeft: "auto", flex: "0 0 auto" }}>{cta}</div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>{logo}</div>
            <div style={{ marginTop: "auto" }}>{text}</div>
            <div style={{ marginTop: 12 }}>{cta}</div>
          </div>
        )}
      </div>
    </div>
  );
}
