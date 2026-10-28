// `crawlproof webhooks ...`: the /api/v1/webhooks routes from the terminal,
// with the caller's crp_ token. Pure over `call`, so tests drive it directly.

type Call = (
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: Record<string, unknown>,
) => Promise<{ status: number; json: Record<string, unknown> }>;
type Io = { write: (line: string) => void; error: (line: string) => void };

export const WEBHOOKS_HELP = `crawlproof webhooks <command> [--site <domain|id>] [--json]
  list                                  endpoints of the site
  create <url> [--events a,b] [--description D]   prints the secret once
  get <id> | delete <id> | test <id> | secret <id> | rotate <id>
  update <id> [--url U] [--events a,b] [--description D] [--enable|--disable]
  deliveries [<id>] [--limit N]         recent deliveries
  retry <delivery-id>                   send one again`;

export async function runWebhooks(
  positional: string[],
  flags: Record<string, string | boolean>,
  call: Call,
  io: Io,
): Promise<number> {
  const [sub = "list", a] = positional;
  const q = new URLSearchParams();
  if (typeof flags.site === "string") q.set("site", flags.site);
  if (typeof flags.limit === "string") q.set("limit", flags.limit);
  const qs = q.toString() ? `?${q}` : "";
  const base = "/api/v1/webhooks";
  const events = typeof flags.events === "string" ? flags.events.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  const need = (what: string) => {
    io.error(`usage: crawlproof webhooks ${sub} <${what}>`);
    return 2;
  };

  let req: [Parameters<Call>[0], string, Record<string, unknown>?];
  switch (sub) {
    case "list":
      req = ["GET", `${base}${qs}`];
      break;
    case "create":
      if (!a) return need("url");
      req = ["POST", `${base}${qs}`, { url: a, ...(events ? { events } : {}), ...(typeof flags.description === "string" ? { description: flags.description } : {}) }];
      break;
    case "get":
      if (!a) return need("id");
      req = ["GET", `${base}/${encodeURIComponent(a)}${qs}`];
      break;
    case "update": {
      if (!a) return need("id");
      const body: Record<string, unknown> = {};
      if (typeof flags.url === "string") body.url = flags.url;
      if (events) body.events = events;
      if (typeof flags.description === "string") body.description = flags.description;
      if (flags.enable) body.enabled = true;
      if (flags.disable) body.enabled = false;
      req = ["PATCH", `${base}/${encodeURIComponent(a)}${qs}`, body];
      break;
    }
    case "delete":
      if (!a) return need("id");
      req = ["DELETE", `${base}/${encodeURIComponent(a)}${qs}`];
      break;
    case "test":
    case "rotate":
      if (!a) return need("id");
      req = ["POST", `${base}/${encodeURIComponent(a)}/${sub}${qs}`];
      break;
    case "secret":
      if (!a) return need("id");
      req = ["GET", `${base}/${encodeURIComponent(a)}/secret${qs}`];
      break;
    case "deliveries":
      req = ["GET", a ? `${base}/${encodeURIComponent(a)}/deliveries${qs}` : `${base}/deliveries${qs}`];
      break;
    case "retry":
      if (!a) return need("delivery-id");
      req = ["POST", `${base}/deliveries/${encodeURIComponent(a)}/retry${qs}`];
      break;
    case "help":
      io.write(WEBHOOKS_HELP);
      return 0;
    default:
      io.error(`unknown webhooks command: ${sub}\n${WEBHOOKS_HELP}`);
      return 2;
  }

  const { status, json } = await call(...req);
  if (status >= 400) {
    io.error(`error: ${String(json.error ?? status)}`);
    return 1;
  }
  if (flags.json) {
    io.write(JSON.stringify(json, null, 2));
    return 0;
  }
  if (sub === "list") {
    const list = (json.endpoints as Array<Record<string, unknown>>) ?? [];
    if (!list.length) io.write("no endpoints");
    for (const e of list) {
      io.write(`${e.id}  ${e.enabled ? "on " : "off"}  ${e.url}  [${(e.events as string[]).join(",")}]${e.description ? `  ${e.description}` : ""}`);
    }
    return 0;
  }
  if (sub === "deliveries") {
    for (const d of (json.deliveries as Array<Record<string, unknown>>) ?? []) {
      io.write(`${d.id}  ${d.status}  ${d.event_type}  attempts=${d.attempts}  ${d.last_status ?? "-"}${d.last_error ? `  ${d.last_error}` : ""}  ${d.created_at}`);
    }
    return 0;
  }
  if (sub === "create") {
    const e = json.endpoint as Record<string, unknown>;
    io.write(`created ${e.id} ${e.url}`);
    io.write(`secret (shown once): ${json.secret}`);
    return 0;
  }
  if (sub === "secret" || sub === "rotate") {
    io.write(String(json.secret));
    return 0;
  }
  if (sub === "test") {
    io.write(json.ok ? `delivered (HTTP ${json.status})` : `failed: ${json.error ?? `HTTP ${json.status}`}`);
    return json.ok ? 0 : 1;
  }
  io.write(JSON.stringify(json, null, 2));
  return 0;
}
