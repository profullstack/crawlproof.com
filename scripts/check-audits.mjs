// One-shot diagnostic: see how many audits, marketing_contacts, and
// lx_sites landed in the last 7 days, broken out by day. Run once
// and discard.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

// Pull SUPABASE_* from /home/ubuntu/src/crawlproof.com/.env
const env = Object.fromEntries(
  readFileSync("/home/ubuntu/src/crawlproof.com/.env", "utf8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "")];
    })
);

const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("missing supabase url / service role key in .env");
  process.exit(1);
}

const sb = createClient(url, key, { auth: { persistSession: false } });

async function countSince(table, days, dateCol = "created_at") {
  const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  const { count, error } = await sb
    .from(table)
    .select("*", { count: "exact", head: true })
    .gte(dateCol, since);
  if (error) return { error: error.message };
  return { count };
}

async function recent(table, dateCol = "created_at", n = 5, extra = "id,created_at") {
  const { data, error } = await sb
    .from(table)
    .select(extra)
    .order(dateCol, { ascending: false })
    .limit(n);
  if (error) return { error: error.message };
  return data;
}

console.log("=== audits ===");
console.log("last 1d:", await countSince("audits", 1));
console.log("last 7d:", await countSince("audits", 7));
console.log("most recent 5:", await recent("audits", "created_at", 5, "id,target_url,status,owner_id,created_at"));

console.log("\n=== marketing_contacts ===");
console.log("last 7d:", await countSince("marketing_contacts", 7));
console.log("most recent 5:", await recent("marketing_contacts", "created_at", 5, "email,source,consented_at,created_at"));

console.log("\n=== lx_site ===");
console.log("total:", await countSince("lx_site", 365));
console.log("most recent 5:", await recent("lx_site", "created_at", 5, "id,domain,blog_root_url,webhook_url,created_at"));

console.log("\n=== usage_events kind=audit_run last 24h ===");
const oneDayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
const { data: ev, error: evErr } = await sb
  .from("usage_events")
  .select("created_at, ip_hash, meta, audit_id, owner_id")
  .eq("kind", "audit_run")
  .gte("created_at", oneDayAgo)
  .order("created_at", { ascending: false })
  .limit(20);
console.log(evErr ?? ev);
