// Remove the two classes the first production run got wrong.
//
// Companion to purge-offniche-keywords.ts, for rows that pipeline wrote before
// PR #213 tightened it. Two verdicts, both computed with the real code rather
// than approximated in SQL:
//
//   1. **Partial-match leaks** — now rejected by `isOnNiche` once it is given
//      the site's own anchors, so this just re-runs the gate.
//   2. **Constructions** — a keyword that IS a `subject x modifier` cross.
//      These pass the gate (they are on-niche by construction) and cannot be
//      found by a volume check, because the buyer-journey model also returns
//      keywords with no volume and those are the best output in the run.
//      Identified by fingerprint against the cross set the planner would build
//      for that site, which is exact.
//
// Prints SQL rather than executing it. Only `queued` rows are ever considered.
//
// Usage: npx tsx scripts/purge-constructed-keywords.ts <dump.json>

import { readFileSync } from "node:fs";
import {
  anchorTokens,
  crossQueries,
  isOnNiche,
  ownAnchorTokens,
  resolveMasters,
  resolveModifiers,
  signature,
  stem,
  tokens,
} from "../lib/lx/topicPlan";

type Row = {
  id: string;
  keyword: string;
  master_keyword: string | null;
  domain: string;
  niche: string | null;
  master_keywords: string[] | null;
  modifiers: string[] | null;
};

function attribute(keyword: string, masters: string[]): string | null {
  let best: string | null = null;
  let bestLen = 0;
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

function extractRows(raw: string): Row[] {
  const slice = raw.slice(raw.indexOf("[{"), raw.lastIndexOf("}]") + 2);
  const text = slice.includes('\\"') ? slice.replace(/\\"/g, '"') : slice;
  const parsed = JSON.parse(text);
  const first = parsed[0];
  return Array.isArray(first?.payload) ? first.payload : parsed;
}

const rows: Row[] = extractRows(readFileSync(process.argv[2], "utf8"));

// One cross-fingerprint set per site, built once.
const crossSigs = new Map<string, Set<string>>();
function crossesFor(row: Row): Set<string> {
  const cached = crossSigs.get(row.domain);
  if (cached) return cached;
  const masters = resolveMasters(row);
  // Depth well past the planner's 3, so a construction is caught regardless of
  // how deep that run happened to go.
  const built = crossQueries(masters, resolveModifiers(row, masters), 8);
  const set = new Set(built.map((c) => signature(c.query)));
  crossSigs.set(row.domain, set);
  return set;
}

type Bucket = { keep: string[]; leak: string[]; built: string[]; ids: string[] };
const bySite = new Map<string, Bucket>();

for (const row of rows) {
  const masters = resolveMasters(row);
  const b = bySite.get(row.domain) ?? { keep: [], leak: [], built: [], ids: [] };

  const master = row.master_keyword ?? attribute(row.keyword, masters);
  const anchors = anchorTokens(row, masters);
  const own = ownAnchorTokens(row, masters);

  const passes =
    master !== null && isOnNiche(row.keyword, master, anchors, own);
  const constructed = crossesFor(row).has(signature(row.keyword));

  if (!passes) {
    b.leak.push(row.keyword);
    b.ids.push(row.id);
  } else if (constructed) {
    b.built.push(row.keyword);
    b.ids.push(row.id);
  } else {
    b.keep.push(row.keyword);
  }
  bySite.set(row.domain, b);
}

const allIds: string[] = [];
let k = 0;
let l = 0;
let c = 0;
for (const [domain, b] of Array.from(bySite).sort()) {
  k += b.keep.length;
  l += b.leak.length;
  c += b.built.length;
  allIds.push(...b.ids);
  console.log(`\n=== ${domain}: keep ${b.keep.length}, leak ${b.leak.length}, constructed ${b.built.length}`);
  if (b.leak.length) console.log(`  leaked      : ${b.leak.join(" | ")}`);
  if (b.built.length) console.log(`  constructed : ${b.built.slice(0, 10).join(" | ")}${b.built.length > 10 ? " | …" : ""}`);
  if (b.keep.length) console.log(`  keeping     : ${b.keep.slice(0, 8).join(" | ")}${b.keep.length > 8 ? " | …" : ""}`);
}

console.log(`\n--- keep ${k}, delete ${l + c} (${l} leaked, ${c} constructed) of ${rows.length}`);
console.log("\n-- SQL:");
for (let i = 0; i < allIds.length; i += 200) {
  console.log(
    `delete from lx_keyword where status='queued' and id in (${allIds
      .slice(i, i + 200)
      .map((id) => `'${id}'`)
      .join(",")});`,
  );
}
