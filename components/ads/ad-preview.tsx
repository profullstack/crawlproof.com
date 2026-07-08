"use client";

import type { CSSProperties } from "react";
import type { AdCreative } from "@/lib/ads/formats";
import { brandInitial, formatSpec, hexToRgba } from "@/lib/ads/formats";

// Live React mirror of renderCreativeHtml (lib/ads/creative.ts). Kept visually
// in sync with the served HTML so the editor preview matches production.
export function AdPreview({ creative, scale = 1 }: { creative: AdCreative; scale?: number }) {
  const { w, h } = formatSpec(creative.format);

  // Native text link — a borderless, full-width single line.
  if (creative.format === "text_link") {
    return (
      <div style={{ width: w * scale, maxWidth: "100%", flex: "0 0 auto" }}>
        <a
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            width: "100%",
            height: h,
            background: creative.bgColor,
            fontFamily: creative.fontFamily,
            fontSize: 13,
            padding: "0 12px",
            overflow: "hidden",
            borderRadius: 8,
            border: "1px solid rgba(255,255,255,.08)",
            borderLeft: `3px solid ${creative.accentColor}`,
            textDecoration: "none",
            boxSizing: "border-box",
          }}
        >
          <span
            style={{
              fontSize: 9,
              letterSpacing: ".12em",
              textTransform: "uppercase",
              color: creative.accentColor,
              flex: "0 0 auto",
            }}
          >
            Sponsored
          </span>
          <strong style={{ color: creative.fgColor, flex: "0 0 auto", whiteSpace: "nowrap" }}>
            {creative.headline}
          </strong>
          {creative.body && (
            <span
              style={{
                color: creative.fgColor,
                opacity: 0.72,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                minWidth: 0,
                flex: "1 1 auto",
              }}
            >
              — {creative.body}
            </span>
          )}
          <span style={{ color: creative.accentColor, fontWeight: 600, flex: "0 0 auto", whiteSpace: "nowrap" }}>
            {creative.ctaText} →
          </span>
        </a>
      </div>
    );
  }

  const isLeaderboard = creative.format === "banner_728x90";
  const isMobile = creative.format === "banner_320x50";
  const row = isLeaderboard || isMobile;
  const showBody = !isMobile;
  const markSize = isMobile ? 20 : 28;

  // Brand mark: real logo, or an accent-tinted monogram tile — never blank.
  const mark = creative.logoUrl ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={creative.logoUrl}
      alt=""
      style={{ height: markSize, width: "auto", maxWidth: markSize * 3, borderRadius: 4, flex: "0 0 auto", objectFit: "contain" }}
    />
  ) : (
    <span
      style={{
        height: markSize,
        width: markSize,
        flex: "0 0 auto",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 6,
        background: creative.accentColor,
        color: creative.bgColor,
        fontWeight: 800,
        fontSize: Math.round(markSize * 0.55),
        lineHeight: 1,
      }}
    >
      {brandInitial(creative.headline)}
    </span>
  );

  const cta = (
    <span
      style={{
        background: creative.accentColor,
        color: creative.bgColor,
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

  const heroText = row ? creative.fgColor : creative.imageUrl ? "#f4f7fb" : creative.fgColor;
  const text = (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
      <div
        style={{
          fontWeight: 700,
          fontSize: isMobile ? 13 : isLeaderboard ? 16 : 18,
          lineHeight: 1.15,
          color: heroText,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: isMobile ? "nowrap" : undefined,
        }}
      >
        {creative.headline}
      </div>
      {showBody && (
        <div style={{ fontSize: isLeaderboard ? 12 : 13, lineHeight: 1.3, color: heroText, opacity: 0.85 }}>
          {creative.body}
        </div>
      )}
    </div>
  );

  // Rectangle background: hero image + gradient, or an accent-tinted brand wash.
  const bg: string = row
    ? creative.bgColor
    : creative.imageUrl
      ? creative.bgColor
      : `radial-gradient(120% 80% at 100% 0%, ${hexToRgba(creative.accentColor, 0.18)} 0%, ${hexToRgba(creative.bgColor, 0)} 60%), ${creative.bgColor}`;

  const box: CSSProperties = {
    position: "relative",
    width: w,
    height: h,
    transform: scale === 1 ? undefined : `scale(${scale})`,
    transformOrigin: "top left",
    background: bg,
    fontFamily: creative.fontFamily,
    borderRadius: 8,
    padding: isMobile ? "8px 10px" : 14,
    overflow: "hidden",
    border: "1px solid rgba(255,255,255,.08)",
    boxSizing: "border-box",
  };

  return (
    <div style={{ width: w * scale, height: h * scale, flex: "0 0 auto" }}>
      <div style={box}>
        {!row && creative.imageUrl && (
          <>
            <div
              style={{
                position: "absolute",
                inset: 0,
                zIndex: 0,
                background: `url('${creative.imageUrl}') center/cover no-repeat`,
              }}
            />
            <div
              style={{
                position: "absolute",
                inset: 0,
                zIndex: 1,
                background: `linear-gradient(180deg, ${hexToRgba(creative.bgColor, 0.15)} 0%, ${hexToRgba(creative.bgColor, 0.86)} 74%)`,
              }}
            />
          </>
        )}
        {row ? (
          <div style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", height: "100%" }}>
            {mark}
            {text}
            <div style={{ marginLeft: "auto", flex: "0 0 auto" }}>{cta}</div>
          </div>
        ) : (
          <div style={{ position: "relative", zIndex: 2, display: "flex", flexDirection: "column", height: "100%" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>{mark}</div>
            <div style={{ marginTop: "auto" }}>{text}</div>
            <div style={{ marginTop: 12 }}>{cta}</div>
          </div>
        )}
      </div>
    </div>
  );
}
