import { ImageResponse } from "next/og";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

// Render the CrawlProof bullet — a single mint dot on the brand background —
// as a 32×32 favicon. Generated at build time and cached.
export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          background: "#0b0d10",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 6,
        }}
      >
        <div
          style={{
            width: 14,
            height: 14,
            background: "#6ee7b7",
            borderRadius: 999,
          }}
        />
      </div>
    ),
    size,
  );
}
