import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

function loadEnv() {
  const env = Object.fromEntries(
    readFileSync("/home/ubuntu/src/crawlproof.com/.env", "utf8")
      .split("\n")
      .filter((line) => line && !line.trimStart().startsWith("#"))
      .map((line) => {
        const i = line.indexOf("=");
        return [line.slice(0, i), line.slice(i + 1).replace(/^"|"$/g, "")];
      }),
  );
  Object.assign(process.env, env);
  return env;
}

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function stripHeadingAttrs(markdown) {
  return markdown.replace(
    /^(#{1,6}[^\n]*?)\s*\{#[a-z0-9][a-z0-9-]*\}\s*$/gim,
    "$1",
  );
}

const env = loadEnv();
const { markdownToHtml } = await import("../lib/markdown.ts");
const { ensureTableOfContentsLinks } = await import("../lib/lx/articleGen.ts");
const { deliverArticle } = await import("../lib/lx/webhookDeliver.ts");

const date = argValue("--date", new Date().toISOString().slice(0, 10));
const dryRun = process.argv.includes("--dry-run");
const noDeliver = process.argv.includes("--no-deliver");
const start = `${date}T00:00:00.000Z`;
const end = new Date(Date.parse(start) + 24 * 60 * 60 * 1000).toISOString();

if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const { data: rows, error } = await sb
  .from("lx_article")
  .select(
    "id, title, status, created_at, published_at, content_markdown, lx_site!lx_article_site_id_fkey(domain)",
  )
  .or(
    `and(created_at.gte.${start},created_at.lt.${end}),and(published_at.gte.${start},published_at.lt.${end})`,
  )
  .order("created_at", { ascending: true });

if (error) {
  console.error("fetch failed:", error.message);
  process.exit(1);
}

console.log(
  `Found ${rows?.length ?? 0} article(s) for ${date} UTC${dryRun ? " (dry run)" : ""}.`,
);

let updated = 0;
let published = 0;
let failed = 0;

for (const row of rows ?? []) {
  const site = Array.isArray(row.lx_site) ? row.lx_site[0] : row.lx_site;
  const label = `${site?.domain ?? "unknown"} :: ${row.title ?? row.id}`;
  if (!row.content_markdown) {
    console.warn(`- ${label}: skipped, no markdown`);
    continue;
  }

  const markdown = ensureTableOfContentsLinks(stripHeadingAttrs(row.content_markdown));
  const html = await markdownToHtml(markdown);

  if (dryRun) {
    const changed = markdown !== row.content_markdown ? "changed" : "unchanged";
    console.log(`- ${label}: would re-render (${changed}) and ${noDeliver ? "not deliver" : "deliver"}`);
    continue;
  }

  const { error: updateError } = await sb
    .from("lx_article")
    .update({
      content_markdown: markdown,
      content_html: html,
      status: "ready",
      webhook_last_error: null,
    })
    .eq("id", row.id);
  if (updateError) {
    failed++;
    console.warn(`- ${label}: update failed — ${updateError.message}`);
    continue;
  }
  updated++;

  if (noDeliver) {
    console.log(`- ${label}: re-rendered, left ready`);
    continue;
  }

  const result = await deliverArticle(row.id, { supabase: sb });
  if (result.ok) {
    published++;
    console.log(`- ${label}: published via webhook (${result.responseCode})`);
  } else {
    failed++;
    console.warn(`- ${label}: delivery failed — ${result.error ?? result.responseCode}`);
  }
}

console.log(
  `Done. updated=${updated} published=${published} failed=${failed} date=${date}`,
);
