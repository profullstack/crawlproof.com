"use client";

import type { CSSProperties } from "react";
import type { AdCreative } from "@/lib/ads/formats";
import {
  brandInitial,
  formatSpec,
  hexToRgba,
  imageScrim,
  overImageShadow,
  paletteFor,
  FEED_FORMAT_ID,
  TERMINAL_FORMAT_ID,
} from "@/lib/ads/formats";
import { hairline, overImageInk, solid, type AdTheme } from "@/lib/ads/theme";
import { renderCreativeText } from "@/lib/ads/terminal";
import { ATTRIBUTION, ctaLabel, DEFAULT_LABEL, oneLine } from "@/lib/ads/feeditem";

// Stand-in for the real /a/<impression_id> click URL, so the preview box is the
// width the served ad will actually be.
const PREVIEW_CLICK_URL = "https://crawlproof.com/a/00000000-0000-0000-0000-000000000000";

// Live React mirror of renderCreativeHtml (lib/ads/creative.ts). Kept visually
// in sync with the served HTML so the editor preview matches production.
export function AdPreview({
  creative,
  scale = 1,
  theme = "dark",
}: {
  creative: AdCreative;
  scale?: number;
  /** Polarity to preview in. Mirrors renderCreativeHtml's `theme` option. */
  theme?: AdTheme;
}) {
  const { w, h } = formatSpec(creative.format);
  const p = paletteFor(creative, theme);
  const edge = hairline(theme);

  // Terminal ad — render the exact ASCII the MOTD endpoint serves, monospaced.
  if (creative.format === TERMINAL_FORMAT_ID) {
    return (
      <div style={{ width: w * scale, maxWidth: "100%", flex: "0 0 auto" }}>
        <pre
          style={{
            margin: 0,
            background: p.bgColor,
            color: p.fgColor,
            border: `1px solid ${edge}`,
            borderRadius: 0,
            padding: "10px 12px",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
            fontSize: 11,
            lineHeight: 1.35,
            whiteSpace: "pre",
            overflowX: "auto",
          }}
        >
          {renderCreativeText(creative, PREVIEW_CLICK_URL)}
        </pre>
      </div>
    );
  }

  // Feed ad — the sponsored line as a reader will actually show it.
  //
  // Deliberately *not* styled to match the other units. The served body carries
  // no CSS at all (readers strip it), so its appearance comes entirely from the
  // subscriber's own stylesheet — and a preview painted in the advertiser's
  // brand colours would promise a look we have no way to deliver. What this
  // shows instead is the structure the reader will get: the disclosure, the
  // headline as a link, the body, the call to action, the attribution.
  if (creative.format === FEED_FORMAT_ID) {
    return (
      <div style={{ width: w * scale, maxWidth: "100%", flex: "0 0 auto" }}>
        <div
          style={{
            background: "#ffffff",
            color: "#1a1a1a",
            border: `1px solid ${hairline("light")}`,
            borderRadius: 8,
            padding: "12px 14px",
            fontFamily: "Georgia, 'Times New Roman', serif",
            fontSize: 14,
            lineHeight: 1.5,
          }}
        >
          <p style={{ margin: 0 }}>
            <strong>{DEFAULT_LABEL}</strong>
            {" \u00b7 "}
            <a style={{ color: "#0645ad", textDecoration: "underline" }}>
              <strong>{oneLine(creative.headline) || "Your headline"}</strong>
            </a>
            {creative.body ? ` \u2014 ${oneLine(creative.body)}` : ""}{" "}
            <a style={{ color: "#0645ad", textDecoration: "underline" }}>
              {ctaLabel(creative.ctaText)} {"\u2192"}
            </a>{" "}
            <small style={{ color: "#666" }}>({ATTRIBUTION})</small>
          </p>
        </div>
        <p style={{ margin: "6px 0 0", fontSize: 11, color: "var(--color-muted)" }}>
          Shown in the subscriber&apos;s reader, which supplies its own styling.
        </p>
      </div>
    );
  }

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
            background: p.bgColor,
            fontFamily: creative.fontFamily,
            fontSize: 13,
            padding: "0 12px",
            overflow: "hidden",
            borderRadius: 0,
            border: `1px solid ${edge}`,
            borderLeft: `3px solid ${p.accentColor}`,
            textDecoration: "none",
            boxSizing: "border-box",
          }}
        >
          <span
            style={{
              fontSize: 9,
              letterSpacing: ".12em",
              textTransform: "uppercase",
              color: p.accentColor,
              flex: "0 0 auto",
            }}
          >
            Sponsored
          </span>
          <strong style={{ color: p.fgColor, flex: "0 0 auto", whiteSpace: "nowrap" }}>
            {creative.headline}
          </strong>
          {creative.body && (
            <span
              style={{
                color: p.fgColor,
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
          <span style={{ color: p.accentColor, fontWeight: 600, flex: "0 0 auto", whiteSpace: "nowrap" }}>
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
        background: p.accentColor,
        color: solid(p.bgColor),
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
        background: p.accentColor,
        color: solid(p.bgColor),
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

  const overImage = !row && Boolean(creative.imageUrl);
  const heroText = overImage ? overImageInk(theme) : p.fgColor;
  // Mirrors renderCreativeHtml: the scrim stops short of opaque so the artwork
  // survives, and the copy carries its own contrast over the image.
  const textShadow = overImage ? overImageShadow(theme) : undefined;
  const text = (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
      <div
        style={{
          fontWeight: 700,
          fontSize: isMobile ? 13 : isLeaderboard ? 16 : 18,
          lineHeight: 1.15,
          color: heroText,
          textShadow,
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
            color: heroText,
            textShadow,
            opacity: overImage ? 0.9 : 0.85,
          }}
        >
          {creative.body}
        </div>
      )}
    </div>
  );

  // Rectangle background: hero image + gradient, or an accent-tinted brand wash.
  const bg: string = row
    ? p.bgColor
    : creative.imageUrl
      ? p.bgColor
      : `radial-gradient(120% 80% at 100% 0%, ${hexToRgba(p.accentColor, 0.18)} 0%, ${hexToRgba(p.bgColor, 0)} 60%), ${p.bgColor}`;

  const box: CSSProperties = {
    position: "relative",
    width: w,
    height: h,
    transform: scale === 1 ? undefined : `scale(${scale})`,
    transformOrigin: "top left",
    background: bg,
    fontFamily: creative.fontFamily,
    borderRadius: 0,
    padding: isMobile ? "8px 10px" : 14,
    overflow: "hidden",
    border: `1px solid ${edge}`,
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
                background: imageScrim(theme),
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
