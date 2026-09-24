// `crawlproof email-tracking` — one implementation for both CLIs (the in-repo
// one and the published @profullstack/crawlproof). Each hands in its own
// token-authed HTTP call, so this file owns only the words.
//
//   crawlproof email-tracking [list] [--json]
//   crawlproof email-tracking show <site|project-id> [--secret] [--json]
//   crawlproof email-tracking enable|disable <site|project-id> [--json]
//   crawlproof email-tracking rotate <site|project-id> [--json]
//
// `show --secret` piped (not a terminal) prints the secret alone, so
//   crawlproof email-tracking show moshcode.sh --secret | myna newsletter track set <id>
// works with nothing in between.

export type ApiCall = (
  method: "GET" | "POST",
  path: string,
) => Promise<{ status: number; json: Record<string, unknown> }>;

export type Out = { write(line: string): void; error(line: string): void; isTTY: boolean };

export const EMAIL_TRACKING_USAGE = `  email-tracking [list] [--json]
      Every project's email tracking: id, on or off, and the last day's
      opens, clicks and unsubscribes. Needs CRAWLPROOF_TOKEN.
  email-tracking show <site|project-id> [--secret] [--json]
      One project. --secret adds the signing secret (owners and members
      only); piped, it prints just the secret.
  email-tracking enable|disable <site|project-id>
      Turn tracking on or off. Unsubscribe links keep working either way.
  email-tracking rotate <site|project-id>
      A new secret. The old one keeps verifying mail already sent.
`;

type Row = {
  project_id: string;
  site: string;
  role: string;
  tracking_id: string;
  enabled: boolean;
  enabled_at: string | null;
  tracking_url: string;
  events_url: string;
  events_24h?: { open: number; click: number; unsubscribe: number };
  secret?: string;
};

const counts = (r: Row): string => (r.events_24h ? `${r.events_24h.open} opens, ${r.events_24h.click} clicks, ${r.events_24h.unsubscribe} unsubs (24h)` : "");

function describe(r: Row): string[] {
  return [
    `${r.site}  ${r.enabled ? "on" : "off"}  (${r.role})`,
    `  tracking id  ${r.tracking_id}`,
    `  tracking     ${r.tracking_url}`,
    `  events       ${r.events_url}`,
    ...(r.events_24h ? [`  last day     ${counts(r)}`] : []),
    ...(r.secret ? [`  secret       ${r.secret}`] : []),
  ];
}

export async function runEmailTracking(positional: string[], flags: Record<string, string | boolean>, call: ApiCall, out: Out): Promise<number> {
  const [sub = "list", ref] = positional;
  const fail = (what: string, status: number, json: Record<string, unknown>): number => {
    out.error(`email-tracking ${what} failed: ${status} ${String(json.error ?? "")}`.trim());
    return 1;
  };
  const path = (r: string) => `/api/v1/email-tracking/${encodeURIComponent(r)}`;

  if (sub === "list") {
    const { status, json } = await call("GET", "/api/v1/email-tracking");
    if (status >= 400) return fail("list", status, json);
    const rows = (json.projects as Row[]) ?? [];
    if (flags.json) {
      out.write(JSON.stringify(rows, null, 2));
      return 0;
    }
    if (!rows.length) out.write("No projects.");
    for (const r of rows) out.write(`${(r.enabled ? "on " : "off").padEnd(4)} ${r.site.padEnd(28)} ${r.tracking_id}  ${counts(r)}`);
    return 0;
  }

  if (!ref) {
    out.error(`usage: crawlproof email-tracking ${sub} <site|project-id>`);
    return 2;
  }

  if (sub === "show") {
    const { status, json } = await call("GET", `${path(ref)}${flags.secret ? "?secret=1" : ""}`);
    if (status >= 400) return fail("show", status, json);
    const row = json as unknown as Row;
    if (flags.json) out.write(JSON.stringify(row, null, 2));
    else if (flags.secret && !out.isTTY) out.write(row.secret ?? "");
    else for (const line of describe(row)) out.write(line);
    return 0;
  }

  if (sub === "enable" || sub === "disable" || sub === "rotate") {
    const { status, json } = await call("POST", `${path(ref)}/${sub}`);
    if (status >= 400) return fail(sub, status, json);
    const row = json as unknown as Row;
    if (flags.json) out.write(JSON.stringify(row, null, 2));
    else if (sub === "rotate") {
      out.write(`New secret for ${row.site}. Mail already sent keeps verifying with the old one until the next rotation.`);
      out.write(out.isTTY ? `  secret  ${row.secret}` : (row.secret ?? ""));
    } else out.write(`${row.site}: email tracking ${row.enabled ? "on" : "off"} (${row.tracking_id})`);
    return 0;
  }

  out.error(`unknown: crawlproof email-tracking ${sub} (expected: list | show | enable | disable | rotate)`);
  return 2;
}
