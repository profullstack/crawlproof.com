// Rendering a /api/tracker/v1/stats answer as plain text.
//
// Pure and string-returning rather than writing to stdout, because two CLIs
// print it now — the in-repo one and the published @profullstack/crawlproof —
// and a printer that owns the process is a printer that cannot be shared or
// tested.

export type StatsItem = { label: string; value: number };

export type StatsAnswerish = {
  project?: { name?: string; url?: string } | null;
  totals?: { visitors?: number; pageviews?: number } | null;
  sources?: StatsItem[] | null;
  referrers?: StatsItem[] | null;
  pages?: StatsItem[] | null;
};

const list = (v: StatsItem[] | null | undefined): StatsItem[] => (Array.isArray(v) ? v : []);

export function renderStats(
  answer: StatsAnswerish,
  { range, who, rows = 10 }: { range: string; who: string; rows?: number },
): string {
  const totals = answer.totals ?? {};
  const out: string[] = [
    `${answer.project?.name ?? "project"}  ${range}  ${who}`,
    `${totals.visitors ?? 0} visitors, ${totals.pageviews ?? 0} pageviews`,
  ];

  const section = (title: string, items: StatsItem[]) => {
    if (!items.length) return;
    out.push("", title);
    const width = Math.min(46, Math.max(...items.map((i) => i.label.length)));
    for (const item of items.slice(0, rows)) {
      out.push(`  ${item.label.slice(0, width).padEnd(width)}  ${item.value}`);
    }
  };
  section("Sources", list(answer.sources));
  section("Referrers", list(answer.referrers));
  section("Pages", list(answer.pages));

  // Nothing at all is a real answer, and the likeliest cause is worth naming.
  if (!(totals.pageviews ?? 0) && !list(answer.sources).length) {
    out.push("", "Nothing in this window. Check the tag is on the page, or widen --range.");
  }
  return `${out.join("\n")}\n`;
}
