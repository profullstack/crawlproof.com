import { describe, it, expect } from "vitest";
import {
  parsePendingInlineMarkers,
  pendingInlineMarker,
} from "@/lib/lx/articleGen";

/**
 * When an inline image fails to generate, the marker used to be deleted and
 * the image was gone for good — that is how a few days of OpenAI quota
 * trouble in August 2026 left published posts permanently short of their
 * art. The marker now survives the failure carrying its own brief, which is
 * the only reason repairMissingArticleImages() can put the image back.
 */
describe("pending inline image markers", () => {
  it("round-trips the brief needed to regenerate the image", () => {
    const marker = pendingInlineMarker({
      index: 2,
      kind: "chart",
      alt: "Latency by transport",
      prompt: "A bar chart comparing WebRTC and HLS end-to-end latency",
    });
    const [parsed] = parsePendingInlineMarkers(`intro\n\n${marker}\n\nbody`);
    expect(parsed.index).toBe(2);
    expect(parsed.kind).toBe("chart");
    expect(parsed.alt).toBe("Latency by transport");
    expect(parsed.prompt).toBe(
      "A bar chart comparing WebRTC and HLS end-to-end latency",
    );
    expect(parsed.raw).toBe(marker);
  });

  it("stays a well-formed HTML comment when the brief contains -- or quotes", () => {
    const marker = pendingInlineMarker({
      index: 1,
      kind: "flow",
      alt: 'the "handoff" path',
      prompt: 'A flow -- from client --> edge -- with a "control" hop',
    });
    // A stray `--` would close the comment early and leak prompt text into
    // the rendered post; a stray quote would truncate the attribute.
    expect(marker.indexOf("--", 4)).toBe(marker.length - 3);
    expect(marker).not.toContain('"the "handoff"');

    const [parsed] = parsePendingInlineMarkers(marker);
    expect(parsed.kind).toBe("flow");
    expect(parsed.prompt).toContain("from client");
  });

  it("finds every pending marker and ignores rendered images", () => {
    const body = [
      "## One",
      pendingInlineMarker({ index: 1, kind: "chart", alt: "a", prompt: "first" }),
      "## Two",
      "![already here](https://example.com/x.png)",
      "## Three",
      pendingInlineMarker({ index: 3, kind: "concept", alt: "c", prompt: "third" }),
    ].join("\n\n");
    const found = parsePendingInlineMarkers(body);
    expect(found.map((f) => f.prompt)).toEqual(["first", "third"]);
    // The ordinal is what names the object in storage, so a repair that
    // fills image 3 must not write over image 1.
    expect(found.map((f) => f.index)).toEqual([1, 3]);
  });

  it("skips a marker with no prompt rather than briefing the model on nothing", () => {
    expect(
      parsePendingInlineMarkers('<!-- INLINE_IMAGE_PENDING n="1" kind="chart" alt="a" prompt="" -->'),
    ).toEqual([]);
  });

  it("returns nothing for a body that has no markers", () => {
    expect(parsePendingInlineMarkers("## Heading\n\nJust prose.")).toEqual([]);
  });
});
