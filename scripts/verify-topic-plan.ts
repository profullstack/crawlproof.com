// Dry-run the topic planner against live rows and print what it WOULD do.
//
// No writes, no API calls. Reads each active site's real subjects, modifiers
// and existing keyword history, and reports the allocation plus the cross
// queries. Exists so the fix can be checked against production shapes rather
// than only against the fixtures in tests/lx/topic-plan.test.ts.
//
// Usage: npx tsx scripts/verify-topic-plan.ts   (needs .env with the service key)

import { createClient } from "@supabase/supabase-js";
import {
  allocate,
  anchorTokens,
  crossQueries,
  isOnNiche,
  resolveMasters,
  resolveModifiers,
} from "../lib/lx/topicPlan";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

async function main() {
  const { data: sites } = await supabase
    .from("lx_site")
    .select("id, domain, niche, master_keywords, seed_keywords, modifiers")
    .eq("status", "active")
    .order("domain");

  for (const site of sites ?? []) {
    const masters = resolveMasters(site as never);
    const modifiers = resolveModifiers(site as never);
    const anchors = anchorTokens(site as never);

    const { data: existing } = await supabase
      .from("lx_keyword")
      .select("keyword, master_keyword")
      .eq("site_id", site.id);

    const coverage = new Map<string, number>();
    for (const row of existing ?? []) {
      const master =
        row.master_keyword ??
        masters.find((m) =>
          row.keyword.toLowerCase().includes(m.toLowerCase()),
        );
      if (master) {
        const k = master.toLowerCase();
        coverage.set(k, (coverage.get(k) ?? 0) + 1);
      }
    }

    const plan = allocate(masters, coverage, 30);
    const crosses = crossQueries(masters, modifiers, 3);
    const coveredByCross = new Set(crosses.map((c) => c.master));

    console.log(`\n=== ${site.domain}`);
    console.log(`  niche      : ${site.niche ?? "(none)"}`);
    console.log(`  masters    : ${masters.length ? masters.join(", ") : "(NONE)"}`);
    console.log(`  modifiers  : ${modifiers.length ? modifiers.join(", ") : "(NONE)"}`);
    console.log(`  anchors    : ${anchors.size}`);
    if (anchors.size === 0) {
      console.log("  !! would ERROR: no niche and no modifiers");
      continue;
    }
    const starved = masters.filter((m) => !coveredByCross.has(m));
    if (starved.length) {
      console.log(`  !! no cross floor for: ${starved.join(", ")}`);
    }
    console.log(
      `  allocation : ${masters
        .map((m) => `${m}=${plan.get(m) ?? 0}(have ${coverage.get(m.toLowerCase()) ?? 0})`)
        .join("  ")}`,
    );
    console.log(`  sample     : ${crosses.slice(0, 6).map((c) => c.query).join(" | ")}`);

    // How the existing published keywords score under the new gate.
    const kept = (existing ?? []).filter((r) => {
      const master = masters.find((m) =>
        r.keyword.toLowerCase().includes(m.toLowerCase()),
      );
      return master ? isOnNiche(r.keyword, master, anchors) : false;
    });
    console.log(
      `  gate       : ${kept.length}/${(existing ?? []).length} existing keywords would pass`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
