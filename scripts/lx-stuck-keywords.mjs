// Inspect the in-flight 'generating' keywords + check for any errors
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

const { data: kws } = await sb
  .from("lx_keyword")
  .select("*")
  .eq("status", "generating")
  .order("updated_at", { ascending: false });

console.log(`generating keywords: ${kws?.length ?? 0}\n`);
for (const k of kws ?? []) {
  console.log(JSON.stringify(k, null, 2));
}

// All-time articles for this site
const { data: arts } = await sb
  .from("lx_article")
  .select("id, site_id, status, title, slug, created_at, updated_at, webhook_last_error")
  .eq("site_id", "1d0e59a1-a6c9-4ea1-b19d-3552778d7f76")
  .order("created_at", { ascending: false })
  .limit(10);
console.log(`\nALL articles for threatcrush.com lx_site: ${arts?.length ?? 0}`);
for (const a of arts ?? []) console.log("  ", JSON.stringify(a));
