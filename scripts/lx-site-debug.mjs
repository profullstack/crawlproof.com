// Dump everything we know about threatcrush.com's autoblog site row
// + how it generated keywords. Helps diagnose off-niche keyword research.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync("/home/ubuntu/src/crawlproof.com/.env", "utf8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "")];
    }),
);

const sb = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const { data: site } = await sb
  .from("lx_site")
  .select("*")
  .eq("domain", "threatcrush.com")
  .maybeSingle();

if (!site) {
  console.error("no site found");
  process.exit(1);
}

console.log("=== lx_site row ===");
for (const [k, v] of Object.entries(site)) {
  const printable = typeof v === "string" && v.length > 200 ? v.slice(0, 200) + "…" : v;
  console.log(`  ${k}: ${JSON.stringify(printable)}`);
}

// All keywords with scores so we can see ranking
const { data: kws } = await sb
  .from("lx_keyword")
  .select("id, keyword, scheduled_for, status, search_volume, source, created_at")
  .eq("site_id", site.id)
  .order("scheduled_for", { ascending: true });
console.log(`\n=== ${kws?.length ?? 0} keywords ===`);
for (const k of kws ?? []) {
  console.log(
    `  ${k.scheduled_for}  vol=${k.search_volume ?? "—"}  src=${k.source ?? "—"}  "${k.keyword}"  (${k.status})`,
  );
}
