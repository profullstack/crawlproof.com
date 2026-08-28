// Decide which QUEUED keywords the new gate would never have created.
//
// Reads a JSON dump of queued rows and prints the ids to delete, plus a
// per-site summary. Prints SQL rather than executing it: this deletes
// scheduled work on live blogs, and the diff between "what the gate rejects"
// and "what I am about to remove" should be readable by a person before it
// runs, not inferred from an exit code.
//
// Only `queued` rows are ever considered. A published article is a URL that
// exists on somebody's blog and possibly in an index; removing its keyword row
// would not unpublish it, it would only lose the record that we wrote it.
//
// Usage: npx tsx scripts/purge-offniche-keywords.ts <dump.json>

import { readFileSync } from "node:fs";
import { anchorTokens, isOnNiche, resolveMasters, stem, tokens } from "../lib/lx/topicPlan";

type Row = {
  id: string;
  keyword: string;
  domain: string;
  niche: string | null;
  master_keywords: string[] | null;
  modifiers: string[] | null;
};

/** Same longest-match attribution the research pipeline uses. */
function attribute(keyword: string, masters: string[]): string | null {
  let best: string | null = null;
  let bestLen = 0;
  // Stemmed on both sides, so attribution and the gate agree about what
  // "promo codes" and "promo code" are. They disagreed before, and a keyword
  // attributed to a subject the gate then could not match was dropped for a
  // reason nobody would have guessed from the strings.
  const candidate = new Set(tokens(keyword).map(stem));
  for (const master of masters) {
    const masterTokens = tokens(master).map(stem);
    if (masterTokens.length === 0) continue;
    const hit = masterTokens.filter((t) => candidate.has(t));
    if (hit.length === 0) continue;
    const len = hit.join("").length;
    if (len > bestLen) {
      bestLen = len;
      best = master;
    }
  }
  return best;
}

/**
 * Pull the rows out of whatever wrapper the dump arrived in.
 *
 * A plain array, or the MCP tool envelope — which is the JSON *escaped* inside
 * a JSON string, so the quotes need unescaping before it will parse, and the
 * rows then sit under a `payload` key.
 */
function extractRows(raw: string): Row[] {
  const slice = raw.slice(raw.indexOf("[{"), raw.lastIndexOf("}]") + 2);
  const text = slice.includes('\\"') ? slice.replace(/\\"/g, '"') : slice;
  const parsed = JSON.parse(text);
  const first = parsed[0];
  return Array.isArray(first?.payload) ? first.payload : parsed;
}

const rows: Row[] = extractRows(readFileSync(process.argv[2], "utf8"));

const bySite = new Map<string, { kept: string[]; dropped: string[]; ids: string[] }>();

const unjudgeable = new Set<string>();

for (const row of rows) {
  const masters = resolveMasters(row);
  const anchors = anchorTokens(row, masters);
  const bucket = bySite.get(row.domain) ?? { kept: [], dropped: [], ids: [] };

  // A site with no subjects configured cannot be judged, and "reject
  // everything" is the wrong reading of "I have no basis for an opinion" —
  // it would empty a queue whose keywords may be perfectly good, as they are
  // on khipu-agency. Left alone, and named in the summary so the real fix
  // (set master keywords) is visible.
  if (masters.length === 0) {
    unjudgeable.add(row.domain);
    bucket.kept.push(row.keyword);
    bySite.set(row.domain, bucket);
    continue;
  }

  const master = attribute(row.keyword, masters);
  const ok = master !== null && anchors.size > 0 && isOnNiche(row.keyword, master, anchors);

  if (ok) bucket.kept.push(row.keyword);
  else {
    bucket.dropped.push(row.keyword);
    bucket.ids.push(row.id);
  }
  bySite.set(row.domain, bucket);
}

const allIds: string[] = [];
let totalKept = 0;
let totalDropped = 0;

for (const [domain, b] of Array.from(bySite).sort()) {
  totalKept += b.kept.length;
  totalDropped += b.dropped.length;
  allIds.push(...b.ids);
  console.log(
    `\n=== ${domain}: keep ${b.kept.length}, drop ${b.dropped.length}`,
  );
  console.log(`  dropping : ${b.dropped.slice(0, 12).join(" | ")}${b.dropped.length > 12 ? " | …" : ""}`);
  console.log(`  keeping  : ${b.kept.slice(0, 8).join(" | ")}${b.kept.length > 8 ? " | …" : ""}`);
}

console.log(`\n--- total: keep ${totalKept}, drop ${totalDropped} of ${rows.length}`);
if (unjudgeable.size > 0) {
  console.log(
    `--- left alone (no master keywords set): ${Array.from(unjudgeable).join(", ")}`,
  );
}
console.log("\n-- SQL:");
for (let i = 0; i < allIds.length; i += 200) {
  const chunk = allIds.slice(i, i + 200);
  console.log(
    `delete from lx_keyword where status='queued' and id in (${chunk
      .map((id) => `'${id}'`)
      .join(",")});`,
  );
}
