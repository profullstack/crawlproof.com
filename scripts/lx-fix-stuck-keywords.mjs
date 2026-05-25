// Flip lx_keyword rows that already have an article_id from 'generating'
// → 'published'. These got stuck because of the missing status-update
// step in articleGen.ts (fixed going forward in the same commit). One-shot.
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

const { data, error } = await sb
  .from("lx_keyword")
  .update({ status: "published" })
  .eq("status", "generating")
  .not("article_id", "is", null)
  .select("id, keyword, article_id");

if (error) {
  console.error("update failed:", error.message);
  process.exit(1);
}
console.log(`Flipped ${data?.length ?? 0} stuck keyword(s) → published:`);
for (const k of data ?? []) console.log(`  ${k.id}  "${k.keyword}"  article=${k.article_id}`);
