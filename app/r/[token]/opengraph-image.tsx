import { ImageResponse } from "next/og";
import { serviceClient } from "@/lib/supabase/service";
import { buildShareCard, type ShareCard } from "@/lib/audit/share-card";

// Per-report social card. Before this existed every /r/<token> link shared the
// one static /banner.png, so a report for acme.com and a report for
// example.org produced byte-identical previews in Slack, X, and LinkedIn.
// The card's value is entirely in naming the scanned site and its score.

export const runtime = "nodejs";
// Scans complete asynchronously, so a card fetched seconds after the share
// link may still read "Scan running…". Short revalidate lets it settle without
// re-querying on every crawler hit.
export const revalidate = 60;

export const alt = "CrawlProof report card";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const BG = "#0b0d10";
const FG = "#e7e9ee";
const MUTED = "#9aa3b2";
const BORDER = "#1f2630";
const ACCENT = "#6ee7b7";

const TONE: Record<string, string> = {
  pass: "#34d399",
  warn: "#fbbf24",
  fail: "#f87171",
  neutral: "#64748b",
};

/** Long hostnames must not wrap or overflow — step the size down instead. */
function hostSize(host: string): number {
  if (host.length > 30) return 52;
  if (host.length > 22) return 66;
  if (host.length > 15) return 82;
  return 96;
}

export default async function Image({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  let card: ShareCard | null = null;
  try {
    const svc = serviceClient();
    const { data } = await svc
      .from("audits")
      .select("target_url, status, score, engine, summary")
      .eq("share_token", token)
      .maybeSingle();
    if (data) card = buildShareCard(data as Parameters<typeof buildShareCard>[0]);
  } catch {
    // A card is decoration on a link preview — never let a DB blip 500 the
    // image and leave the crawler with no thumbnail at all.
    card = null;
  }

  const tone = TONE[card?.tone ?? "neutral"];

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
          <div
            style={{
              display: "flex",
              fontSize: 26,
              fontWeight: 700,
              letterSpacing: 6,
              color: ACCENT,
            }}
          >
            CRAWLPROOF
          </div>
          <div style={{ display: "flex", fontSize: 26, color: MUTED, letterSpacing: 2 }}>
            {card ? card.label.toUpperCase() : "SITE AUDIT"}
          </div>
        </div>

        {card ? (
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div
              style={{
                display: "flex",
                fontSize: hostSize(card.host),
                fontWeight: 800,
                color: FG,
                lineHeight: 1.05,
              }}
            >
              {card.host}
            </div>

            <div style={{ display: "flex", alignItems: "flex-end", marginTop: 28, gap: 28 }}>
              {card.score !== null ? (
                <div style={{ display: "flex", alignItems: "flex-end" }}>
                  <div style={{ display: "flex", fontSize: 132, fontWeight: 800, color: tone, lineHeight: 0.9 }}>
                    {card.score}
                  </div>
                  <div style={{ display: "flex", fontSize: 38, color: MUTED, marginLeft: 10, marginBottom: 12 }}>
                    /100
                  </div>
                </div>
              ) : (
                <div style={{ display: "flex", fontSize: 62, fontWeight: 700, color: MUTED }}>
                  {card.headline}
                </div>
              )}
              {card.score !== null && (
                <div style={{ display: "flex", fontSize: 34, color: MUTED, marginBottom: 18 }}>
                  {card.headline}
                </div>
              )}
            </div>

            {card.score !== null && (
              <div style={{ display: "flex", flexDirection: "column", marginTop: 34 }}>
                <div
                  style={{
                    display: "flex",
                    width: "100%",
                    height: 16,
                    borderRadius: 999,
                    background: BORDER,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      width: `${card.fill}%`,
                      height: "100%",
                      borderRadius: 999,
                      background: tone,
                    }}
                  />
                </div>
                <div style={{ display: "flex", fontSize: 24, color: MUTED, marginTop: 16 }}>
                  {card.scaleHint}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", fontSize: 82, fontWeight: 800, color: FG }}>
              See your site the way AI crawlers do.
            </div>
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", fontSize: 26, color: MUTED }}>
            {card ? card.footer : "SEO · AEO · GEO audit — free, no signup"}
          </div>
          <div style={{ display: "flex", fontSize: 26, color: ACCENT }}>crawlproof.com</div>
        </div>
      </div>
    ),
    size,
  );
}
