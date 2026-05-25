// One-shot cleanup: hard-delete the archived projects for threatcrush.com
// and coinpayportal.com so the lx_site domain unique-index releases and
// the user can recreate them. Only deletes rows that are:
//   - owned by anthony@profullstack.com
//   - status='archived'
//   - have one of the two targeted hostnames in their URL
// Anything else is reported and skipped. Run once and discard.
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

const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("missing supabase url / service role key in .env");
  process.exit(1);
}

const sb = createClient(url, key, { auth: { persistSession: false } });

const OWNER_EMAIL = "anthony@profullstack.com";
const TARGET_DOMAINS = ["threatcrush.com", "coinpayportal.com"];

function hostOf(rawUrl) {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

const { data: ownerRow, error: ownerErr } = await sb
  .from("marketing_contacts")
  .select("user_id, email")
  .eq("email", OWNER_EMAIL)
  .maybeSingle();
let ownerId = ownerRow?.user_id;
if (!ownerId) {
  const { data: list } = await sb.auth.admin.listUsers({ page: 1, perPage: 200 });
  ownerId = list?.users?.find((u) => u.email === OWNER_EMAIL)?.id;
}
if (!ownerId) {
  console.error("could not resolve owner_id for", OWNER_EMAIL, ownerErr);
  process.exit(1);
}
console.log(`Owner: ${OWNER_EMAIL} → ${ownerId}`);

const { data: projects, error: projErr } = await sb
  .from("projects")
  .select("id, name, url, status, archived_at, created_at")
  .eq("owner_id", ownerId)
  .order("created_at", { ascending: false });
if (projErr) {
  console.error("project query failed:", projErr.message);
  process.exit(1);
}

const matches = (projects ?? []).filter((p) => {
  const host = hostOf(p.url);
  return host && TARGET_DOMAINS.includes(host);
});

console.log(`\nFound ${matches.length} project row(s) matching target domains:`);
for (const p of matches) {
  console.log(
    `  [${p.status}] ${p.id}  ${p.url}  (archived_at=${p.archived_at ?? "—"})`,
  );
}

const archived = matches.filter((p) => p.status === "archived");
if (archived.length === 0) {
  console.log("\nNothing to delete — none are archived. Exiting without changes.");
  process.exit(0);
}
console.log(`\nDeleting ${archived.length} archived project row(s)…`);

for (const p of archived) {
  // Surface what cascade is about to wipe so the run is auditable.
  const { count: siteCount } = await sb
    .from("lx_site")
    .select("id", { count: "exact", head: true })
    .eq("project_id", p.id);
  const { count: auditCount } = await sb
    .from("audits")
    .select("id", { count: "exact", head: true })
    .eq("project_id", p.id);
  console.log(
    `  · ${p.id} ${p.url}  → cascading delete will remove lx_site=${siteCount ?? 0}, audits=${auditCount ?? 0}`,
  );

  const { error: delErr } = await sb.from("projects").delete().eq("id", p.id);
  if (delErr) {
    console.error(`    ✗ delete failed: ${delErr.message}`);
  } else {
    console.log(`    ✓ deleted`);
  }
}

console.log("\nDone.");
