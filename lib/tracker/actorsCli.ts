// `crawlproof actors`: declared actors from the command line.
//
// Shared by both CLIs, the in-repo one (cli/index.ts) and the published
// @profullstack/crawlproof (packages/cli), the same way lib/emailTracking/cli
// is. It only talks to /api/tracker/v1/actors through the caller's `call`, so
// each CLI keeps its own token and base-URL handling.
//
// Model and trust rule: lib/tracker/actors.ts. Opt-in and self-reported; an
// agent is believed, a human never overrides bot detection.

type Method = "GET" | "POST" | "PATCH" | "DELETE";
type ApiCall = (method: Method, path: string, body?: Record<string, unknown>) => Promise<{ status: number; json: Record<string, unknown> }>;
type Out = { write: (line: string) => void; error: (line: string) => void };

type Row = {
  id: string;
  email: string;
  name: string;
  kind: string;
  email_verified: boolean;
  visibility: string;
  tokens: { id: string; prefix: string; label: string; last_used_at: string | null }[];
  last30: { events: number; pageviews: number; contradictions: number; sites: number };
};

export const ACTORS_USAGE = `  actors [list] [--json]
  actors add <email> --kind=human|agent [--name=…] [--operator=<human email>]
             [--public] [--token-label=…] [--no-token] [--json]
  actors token <email|id> [--label=…]
  actors revoke <email|id> [--token=<token id>]
      Declared actors: say who you are, and whether you are a person, on every
      site with the CrawlProof tracker. Opt-in and self-reported. A token
      (cpa_…) is the credential, never the email; send it as the
      Crawlproof-Actor header or open a site once with ?crp_actor=. An
      agent is believed; a human never overrides bot detection and a mismatch
      is counted as a contradiction. Names are visible to you only unless
      --public. Your login address is verified on creation; any other gets a
      verification email. Needs an API token.
`;

/** How to send a fresh actor token. Pure, for tests. */
export function actorTokenHowTo(token: string): string {
  return [
    `token (shown once): ${token}`,
    "",
    "Send it with your visits by any of:",
    `  header   Crawlproof-Actor: ${token}        (Playwright extraHTTPHeaders, Puppeteer setExtraHTTPHeaders)`,
    `  link     https://<tracked site>/?crp_actor=${token}   (stored for that site, stripped from the URL)`,
    `  script   crawlproof('actor', '${token}')`,
    "Or, for a person: Dashboard → Settings → Declared actors → Declare this browser.",
    "",
  ].join("\n");
}

export async function runActors(
  positional: string[],
  flags: Record<string, string | boolean>,
  call: ApiCall,
  out: Out,
): Promise<number> {
  const sub = positional[0] ?? "list";
  const json = Boolean(flags.json);
  const fail = (what: string, r: { status: number; json: Record<string, unknown> }) => {
    out.error(`actors ${what} failed: ${r.status} ${String(r.json.error ?? "")}`.trim());
    return 1;
  };
  const list = async () => {
    const r = await call("GET", "/api/tracker/v1/actors");
    return { r, actors: (r.json.actors as Row[] | undefined) ?? [] };
  };
  const find = (actors: Row[], key: string | undefined) =>
    key ? actors.find((a) => a.id === key || a.email === key.toLowerCase()) : undefined;

  if (sub === "list") {
    const { r, actors } = await list();
    if (r.status >= 400) return fail("list", r);
    if (json) {
      out.write(JSON.stringify(actors, null, 2));
      return 0;
    }
    if (!actors.length) out.write("No actors yet. crawlproof actors add <email> --kind=human|agent");
    for (const a of actors) {
      const u = a.last30;
      const flagged = u.contradictions ? `, ${u.contradictions} contradicted` : "";
      out.write(`${a.kind.padEnd(5)} ${a.email}${a.name ? ` (${a.name})` : ""}  ${a.email_verified ? "verified" : "unverified"}, ${a.visibility}  ${a.id}`);
      out.write(`      30d: ${u.pageviews} pv, ${u.events} ev on ${u.sites} site${u.sites === 1 ? "" : "s"}${flagged}`);
      for (const t of a.tokens) {
        out.write(`      token ${t.prefix}…  ${t.label || "(no label)"}  last used ${t.last_used_at?.slice(0, 16).replace("T", " ") ?? "never"}  ${t.id}`);
      }
    }
    return 0;
  }

  if (sub === "add") {
    const email = positional[1];
    const kind = flags.kind;
    if (!email || (kind !== "human" && kind !== "agent")) {
      out.error("usage: crawlproof actors add <email> --kind=human|agent [--name=…] [--operator=<human email>] [--public] [--token-label=…] [--no-token] [--json]");
      return 2;
    }
    const body: Record<string, unknown> = { email, kind, visibility: flags.public ? "public" : "private" };
    if (typeof flags.name === "string") body.name = flags.name;
    if (typeof flags.operator === "string") body.operator = flags.operator;
    if (!flags["no-token"]) body.token_label = typeof flags["token-label"] === "string" ? flags["token-label"] : "cli";
    const r = await call("POST", "/api/tracker/v1/actors", body);
    if (r.status >= 400) return fail("add", r);
    if (json) {
      out.write(JSON.stringify(r.json, null, 2));
      return 0;
    }
    const actor = r.json.actor as { id: string; email: string; kind: string };
    const verification =
      {
        "owner-login": "verified (it is your login)",
        sent: "verification email sent",
        "not-sent": `NOT verified: email could not be sent (${String(r.json.verificationError ?? "unknown")})`,
      }[String(r.json.verification)] ?? "";
    out.write(`${actor.kind} ${actor.email}  ${actor.id}`);
    out.write(verification);
    if (r.json.token) out.write(`\n${actorTokenHowTo(String(r.json.token))}`);
    return 0;
  }

  if (sub === "token") {
    const { r, actors } = await list();
    if (r.status >= 400) return fail("token", r);
    const actor = find(actors, positional[1]);
    if (!actor) {
      out.error("usage: crawlproof actors token <email|id> [--label=…]   (crawlproof actors list shows yours)");
      return 2;
    }
    const label = typeof flags.label === "string" ? flags.label : "cli";
    const m = await call("POST", `/api/tracker/v1/actors/${actor.id}/tokens`, { label });
    if (m.status >= 400) return fail("token", m);
    out.write(json ? JSON.stringify(m.json, null, 2) : actorTokenHowTo(String(m.json.token)));
    return 0;
  }

  if (sub === "revoke") {
    const { r, actors } = await list();
    if (r.status >= 400) return fail("revoke", r);
    const actor = find(actors, positional[1]);
    if (!actor) {
      out.error("usage: crawlproof actors revoke <email|id> [--token=<token id>]   (no --token revokes the actor and every token)");
      return 2;
    }
    const tokenId = typeof flags.token === "string" ? flags.token : undefined;
    const d = tokenId
      ? await call("DELETE", `/api/tracker/v1/actors/${actor.id}/tokens?token=${encodeURIComponent(tokenId)}`)
      : await call("DELETE", `/api/tracker/v1/actors/${actor.id}`);
    if (d.status >= 400) return fail("revoke", d);
    out.write(tokenId ? `revoked token ${tokenId} of ${actor.email}` : `revoked ${actor.email} and all its tokens`);
    return 0;
  }

  out.error(`unknown: crawlproof actors ${sub} (expected: list | add | token | revoke)`);
  return 2;
}
