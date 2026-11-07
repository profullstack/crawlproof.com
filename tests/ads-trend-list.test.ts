import { describe, expect, it } from "vitest";
import { publicTrendList } from "@/lib/ads/trendList";

const NOW = Date.parse("2026-11-07T12:00:00Z");
const row = (topic: string, label: string, ingested_at: string) => ({
  source: "rssamp",
  topic,
  label,
  mentions: 60,
  prior_mentions: 2,
  score: 40,
  window_days: 7,
  generated_at: null,
  ingested_at,
});

function client(rows: unknown[]) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    limit: async () => ({ data: rows, error: null }),
  };
  return { from: () => chain } as never;
}

describe("publicTrendList", () => {
  it("shows the subject as written and keeps the match key beside it", async () => {
    const list = await publicTrendList(client([row("midterm result", "midterm results", "2026-11-07T11:00:00Z")]), { now: NOW });
    expect(list.stale).toBe(false);
    expect(list.topics).toEqual([
      { topic: "midterm results", match_key: "midterm result", score: 40, feeds: 60, prior_feeds: 2 },
    ]);
  });

  it("says when the list has stopped steering delivery", async () => {
    const list = await publicTrendList(client([row("a", "a", "2026-11-01T11:00:00Z")]), { now: NOW });
    expect(list.stale).toBe(true);
    expect(list.topics).toHaveLength(1);
  });

  it("is not stale when there is simply nothing yet", async () => {
    const list = await publicTrendList(client([]), { now: NOW });
    expect(list).toMatchObject({ stale: false, ingested_at: null, topics: [] });
  });
});
