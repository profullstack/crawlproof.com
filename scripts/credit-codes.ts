#!/usr/bin/env bun
// Mint, list and revoke credit codes with the service role (admin, on the box).
//
//   set -a; . ~/www/crawlproof.com/app.env; set +a
//   bun scripts/credit-codes.ts mint 100 --label "for Preshy" [--max 1] [--expires 2026-12-31]
//   bun scripts/credit-codes.ts list
//   bun scripts/credit-codes.ts revoke crd_xxx
//
// A code grants scan credits into profiles.credits_balance when redeemed. The
// plaintext is printed once; only its sha256 is stored.

import { getCreditDeps, mintCreditCode } from "@/lib/creditCodes";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "mint") {
    const credits = Number(rest[0]);
    const expires = flag(rest, "expires");
    const minted = await mintCreditCode({
      credits,
      label: flag(rest, "label"),
      maxRedemptions: Number(flag(rest, "max") ?? 1),
      expiresAt: expires ? Date.parse(expires) : null,
      createdBy: "script",
    });
    console.log(JSON.stringify(minted, null, 2));
    return;
  }
  if (cmd === "list") {
    for (const c of await getCreditDeps().credits.list()) {
      console.log(`${c.id}\t${c.grant.amount} cr\t${c.redemptions}/${c.maxRedemptions}\t${c.revokedAt ? "revoked" : "live"}\t${c.label}`);
    }
    return;
  }
  if (cmd === "revoke" && rest[0]) {
    await getCreditDeps().credits.revoke(rest[0]);
    console.log("revoked", rest[0]);
    return;
  }
  console.error("usage: credit-codes.ts mint <credits> [--label L] [--max N] [--expires YYYY-MM-DD] | list | revoke <id>");
  process.exit(2);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
