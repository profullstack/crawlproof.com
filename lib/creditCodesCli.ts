// `crawlproof redeem <code>` and `crawlproof invites [list|create|accept|revoke]`.
// Pure over an injected API caller so tests need no network.

type Call = (
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: Record<string, unknown>,
) => Promise<{ status: number; json: Record<string, unknown> }>;
type Out = { write: (line: string) => void; error: (line: string) => void };

export async function runRedeem(positional: string[], flags: Record<string, string | boolean>, call: Call, out: Out): Promise<number> {
  const code = positional[0];
  if (!code) {
    out.error("usage: crawlproof redeem <CR-XXXX-XXXX-XXXX-XXXX>");
    return 2;
  }
  const { status, json } = await call("POST", "/api/credits/redeem", { code });
  if (flags.json) out.write(JSON.stringify(json, null, 2));
  if (status >= 400) {
    if (!flags.json) out.error(`error: ${String(json.error ?? status)}`);
    return 1;
  }
  if (!flags.json) out.write(`${String(json.message)} Balance: ${String(json.balance ?? "?")} credits.`);
  return 0;
}

type InviteJson = {
  id: string;
  note?: string;
  status: string;
  expiresAt?: number | null;
  usedByEmail?: string | null;
  bonus?: string;
};

export async function runInvites(positional: string[], flags: Record<string, string | boolean>, call: Call, out: Out): Promise<number> {
  const sub = positional[0] ?? "list";
  const fail = (json: Record<string, unknown>, status: number) => {
    if (flags.json) out.write(JSON.stringify(json, null, 2));
    else out.error(`error: ${String(json.error ?? status)}`);
    return 1;
  };

  if (sub === "list") {
    const { status, json } = await call("GET", "/api/invites");
    if (status >= 400) return fail(json, status);
    if (flags.json) {
      out.write(JSON.stringify(json, null, 2));
      return 0;
    }
    const q = json.quota as { left: number; total: number };
    out.write(`${q.left} of ${q.total} invites left${json.canInvite ? "" : " (locked: " + String(json.blockedReason ?? "account too new") + ")"}`);
    for (const i of (json.invites as InviteJson[]) ?? []) {
      const who = i.status === "used" ? ` -> ${i.usedByEmail ?? "someone"} (bonus ${i.bonus})` : "";
      out.write(`  ${i.id}  ${i.status}${who}${i.note ? `  "${i.note}"` : ""}`);
    }
    return 0;
  }
  if (sub === "create") {
    const note = typeof flags.note === "string" ? flags.note : (positional.slice(1).join(" ") || "");
    const { status, json } = await call("POST", "/api/invites", { note });
    if (status >= 400) return fail(json, status);
    if (flags.json) out.write(JSON.stringify(json, null, 2));
    else out.write(`${String(json.url)}\n  code ${String(json.code)} (shown once)`);
    return 0;
  }
  if (sub === "accept") {
    const code = positional[1];
    if (!code) {
      out.error("usage: crawlproof invites accept <INV-XXXX-XXXX-XXXX>");
      return 2;
    }
    const { status, json } = await call("POST", "/api/invites/accept", { code });
    if (status >= 400) return fail(json, status);
    out.write(flags.json ? JSON.stringify(json, null, 2) : String(json.message));
    return 0;
  }
  if (sub === "revoke") {
    const id = positional[1];
    if (!id) {
      out.error("usage: crawlproof invites revoke <invite id>");
      return 2;
    }
    const { status, json } = await call("DELETE", `/api/invites/${encodeURIComponent(id)}`);
    if (status >= 400) return fail(json, status);
    out.write(flags.json ? JSON.stringify(json) : "Invite withdrawn.");
    return 0;
  }
  out.error("usage: crawlproof invites [list|create [--note N]|accept <code>|revoke <id>]");
  return 2;
}
