import { ImageResponse } from "next/og";
import { serviceClient } from "@/lib/supabase/service";

export const runtime = "nodejs";
export const revalidate = 300;
export const alt = "CrawlProof survey invitation";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const svc = serviceClient();
  const { data: survey } = await svc.from("surveys")
    .select("title, question, project_id")
    .eq("slug", slug)
    .maybeSingle();
  const { data: project } = survey
    ? await svc.from("projects").select("name").eq("id", survey.project_id).maybeSingle()
    : { data: null };
  const title = survey?.title ?? "One question. Better feedback.";
  const question = survey?.question ?? "Share what you think.";
  const site = project?.name?.trim() || "CrawlProof Survey";
  const titleSize = title.length > 48 ? 54 : title.length > 28 ? 68 : 82;

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", background: "#0b0d10", padding: "64px 72px", color: "#e7e9ee", fontFamily: "sans-serif" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", color: "#6ee7b7", fontSize: 26, fontWeight: 700, letterSpacing: 6 }}>CRAWLPROOF</div>
          <div style={{ display: "flex", color: "#9aa3b2", fontSize: 24 }}>{site}</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 26 }}>
          <div style={{ display: "flex", fontSize: 24, color: "#6ee7b7", textTransform: "uppercase", letterSpacing: 4 }}>Feedback survey</div>
          <div style={{ display: "flex", fontSize: titleSize, lineHeight: 1.08, fontWeight: 800, maxWidth: 1030 }}>{title}</div>
          <div style={{ display: "flex", color: "#9aa3b2", fontSize: 32, lineHeight: 1.25, maxWidth: 1000 }}>{question}</div>
        </div>
        <div style={{ display: "flex", borderTop: "1px solid #1f2630", paddingTop: 24, color: "#9aa3b2", fontSize: 22 }}>Share your feedback · crawlproof.com</div>
      </div>
    ),
    size,
  );
}
