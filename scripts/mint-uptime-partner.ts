#!/usr/bin/env bun
// Mint (or rotate) a partner token for the uptime API (/api/uptime/v1), and
// list or revoke partners. Run on the box with the service role:
//
//   set -a; . ~/www/crawlproof.com/app.env; set +a
//   bun scripts/mint-uptime-partner.ts w3bs          # prints cpu_… once
//   bun scripts/mint-uptime-partner.ts --list
//   bun scripts/mint-uptime-partner.ts --revoke w3bs
//
// Only the sha256 of the token is stored. Minting an existing name rotates it
// (the old token stops working) and clears any revocation.
import { createClient } from "@supabase/supabase-js";
import { hashPartnerToken, mintPartnerToken } from "../lib/uptime-partner";

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (source app.env).");
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const [arg, name] = process.argv.slice(2);

  if (arg === "--list") {
    const { data, error } = await sb.from("uptime_partners").select("name, created_at, revoked_at").order("name");
    if (error) throw new Error(error.message);
    for (const p of data ?? []) console.log(`${p.name}\tcreated ${p.created_at}${p.revoked_at ? `\tREVOKED ${p.revoked_at}` : ""}`);
    return;
  }
  if (arg === "--revoke") {
    if (!name) throw new Error("usage: --revoke <name>");
    const { data, error } = await sb.from("uptime_partners").update({ revoked_at: new Date().toISOString() }).eq("name", name).select("name");
    if (error) throw new Error(error.message);
    console.log(data?.length ? `revoked ${name}` : `no partner named ${name}`);
    return;
  }
  if (!arg || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(arg)) {
    throw new Error("usage: bun scripts/mint-uptime-partner.ts <name> | --list | --revoke <name>");
  }
  const token = mintPartnerToken();
  const { error } = await sb
    .from("uptime_partners")
    .upsert({ name: arg, token_hash: hashPartnerToken(token), revoked_at: null }, { onConflict: "name" });
  if (error) throw new Error(error.message);
  console.log(token);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
