// Diagnose autoblog queue state for anthony@profullstack.com.
// Prints active sites, queued keywords, recent articles, and any stuck rows.
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

const OWNER_EMAIL = "anthony@profullstack.com";

const { data: users } = await sb.auth.admin.listUsers({ page: 1, perPage: 200 });
const ownerId = users?.users?.find((u) => u.email === OWNER_EMAIL)?.id;
if (!ownerId) {
  console.error("owner not found");
  process.exit(1);
}
console.log("Owner:", ownerId, OWNER_EMAIL);

const { data: sites } = await sb
  .from("lx_site")
  .select("id, project_id, domain, status, next_publish_at, last_sitemap_fetch_at, sitemap_status, created_at")
  .eq("user_id", ownerId)
  .order("created_at", { ascending: false });

console.log(`\n=== sites (${sites?.length ?? 0}) ===`);
for (const s of sites ?? []) {
  console.log(`  ${s.id}  ${s.domain}  status=${s.status}  next_publish_at=${s.next_publish_at ?? "—"}  sitemap=${s.sitemap_status ?? "—"}`);
}

for (const s of sites ?? []) {
  console.log(`\n--- ${s.domain} (${s.id}) ---`);

  const kw = await sb
    .from("lx_keyword")
    .select("status", { count: "exact" })
    .eq("site_id", s.id);
  const byStatus = {};
  for (const row of kw.data ?? []) byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
  console.log("  keywords by status:", byStatus, `(total=${kw.count ?? 0})`);

  const { data: nextKw } = await sb
    .from("lx_keyword")
    .select("id, keyword, status, scheduled_for")
    .eq("site_id", s.id)
    .eq("status", "queued")
    .order("scheduled_for", { ascending: true })
    .limit(3);
  if (nextKw?.length) {
    console.log("  next queued keywords:");
    for (const k of nextKw) console.log(`    [${k.status}] ${k.scheduled_for}  "${k.keyword}"  (${k.id})`);
  }

  const { data: arts } = await sb
    .from("lx_article")
    .select("id, status, title, created_at, webhook_attempts, webhook_response_code, webhook_last_error")
    .eq("site_id", s.id)
    .order("created_at", { ascending: false })
    .limit(8);
  console.log(`  recent articles (${arts?.length ?? 0}):`);
  for (const a of arts ?? []) {
    const errBit = a.webhook_last_error ? ` err="${a.webhook_last_error.slice(0, 60)}"` : "";
    console.log(`    [${a.status}] ${a.created_at}  ${(a.title ?? "(no title)").slice(0, 50)}  attempts=${a.webhook_attempts ?? 0} code=${a.webhook_response_code ?? "-"}${errBit}  (${a.id})`);
  }
}

// Stuck check: articles in 'generating' for > 10 min, keywords in 'generating' > 10 min
const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
const { data: stuckArts } = await sb
  .from("lx_article")
  .select("id, site_id, status, created_at")
  .eq("status", "generating")
  .lt("created_at", tenMinAgo);
const { data: stuckKws } = await sb
  .from("lx_keyword")
  .select("id, site_id, status, scheduled_for")
  .eq("status", "generating")
  .lt("scheduled_for", tenMinAgo);
console.log(`\n=== stuck > 10m: articles=${stuckArts?.length ?? 0}  keywords=${stuckKws?.length ?? 0} ===`);
for (const a of stuckArts ?? []) console.log("  article", a.id, "site", a.site_id, "created", a.created_at);
for (const k of stuckKws ?? []) console.log("  keyword", k.id, "site", k.site_id, "scheduled", k.scheduled_for);

// Worker reachability — does the deployed app know where the worker is?
console.log("\n=== env hints ===");
console.log("  WORKER_URL (in this .env):", env.WORKER_URL || "(unset)");
console.log("  WORKER_SHARED_SECRET set:", !!env.WORKER_SHARED_SECRET);
