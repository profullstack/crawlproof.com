// Strip pandoc-style {#anchor-id} from stored lx_article markdown
// (which leaked through as visible text) and re-render the HTML so the
// TOC links land on auto-slugged heading IDs.
//
// Uses lib/markdown.ts so the re-render path matches production exactly.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { markdownToHtml } from "../lib/markdown.ts";

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

const { data: rows, error } = await sb
  .from("lx_article")
  .select("id, content_markdown");
if (error) {
  console.error("fetch failed:", error.message);
  process.exit(1);
}

let touched = 0;
for (const r of rows ?? []) {
  const cleaned = r.content_markdown.replace(
    /^(#{1,6}[^\n]*?)\s*\{#[a-z0-9][a-z0-9-]*\}\s*$/gim,
    "$1",
  );
  if (cleaned === r.content_markdown) continue;
  const html = await markdownToHtml(cleaned);
  const { error: upErr } = await sb
    .from("lx_article")
    .update({ content_markdown: cleaned, content_html: html })
    .eq("id", r.id);
  if (upErr) {
    console.warn(`  ${r.id}: update failed —`, upErr.message);
    continue;
  }
  touched++;
  console.log(`  ${r.id}: re-rendered (was ${r.content_markdown.length} chars, now ${cleaned.length})`);
}
console.log(`\nDone — ${touched}/${rows?.length ?? 0} articles updated.`);
