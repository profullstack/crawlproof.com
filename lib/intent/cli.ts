// `crawlproof intent [watches|create|run|leads|reply|status]`
// Pure over an injected API caller so tests need no network.

type Call = (
  method: "GET" | "POST" | "DELETE" | "PATCH",
  path: string,
  body?: Record<string, unknown>,
) => Promise<{ status: number; json: Record<string, unknown> }>;
type Out = { write: (line: string) => void; error: (line: string) => void };

export const INTENT_USAGE = `usage:
  crawlproof intent watches
  crawlproof intent create <name> --keywords "a, b" [--competitors "x, y"] [--sells "..."] [--cadence daily|4h|hourly]
  crawlproof intent run <watch-id>
  crawlproof intent leads [--watch <id>] [--tier hot|engage|monitor] [--status new|replied|dismissed] [--csv]
  crawlproof intent reply <lead-id> [--regenerate]
  crawlproof intent status <lead-id> new|replied|dismissed`;

type Lead = { id: string; score: number; tier: string; source: string; title: string; url: string; status: string };

export async function runIntent(
  positional: string[],
  flags: Record<string, string | boolean>,
  call: Call,
  out: Out,
  rawGet?: (path: string) => Promise<{ status: number; text: string }>,
): Promise<number> {
  const [sub = "leads", arg, arg2] = positional;
  const str = (k: string) => (typeof flags[k] === "string" ? (flags[k] as string) : undefined);
  const done = (status: number, json: Record<string, unknown>, ok: () => void): number => {
    if (flags.json) out.write(JSON.stringify(json, null, 2));
    if (status >= 400) {
      if (!flags.json) out.error(`error: ${String(json.error ?? status)}`);
      return 1;
    }
    if (!flags.json) ok();
    return 0;
  };

  switch (sub) {
    case "watches": {
      const { status, json } = await call("GET", "/api/intent/v1/watches");
      return done(status, json, () => {
        const ws = (json.watches ?? []) as Array<Record<string, unknown>>;
        if (!ws.length) out.write("No watches. Create one: crawlproof intent create <name> --keywords \"...\"");
        for (const w of ws)
          out.write(`${w.id}  ${w.name}  ${w.cadence}${w.active ? "" : " (paused)"}  [${[...((w.keywords as string[]) ?? []), ...((w.competitors as string[]) ?? [])].join(", ")}]`);
      });
    }
    case "create": {
      if (!arg) {
        out.error(INTENT_USAGE);
        return 2;
      }
      const { status, json } = await call("POST", "/api/intent/v1/watches", {
        name: arg,
        keywords: str("keywords"),
        competitors: str("competitors"),
        sells: str("sells"),
        cadence: str("cadence"),
        sources: str("sources"),
      });
      if (status >= 400) return done(status, json, () => undefined);
      const id = (json.watch as { id: string }).id;
      const run = await call("POST", `/api/intent/v1/watches/${id}/run`);
      return done(run.status, { watch: json.watch, first_sweep: run.json }, () =>
        out.write(`Created ${id}. First sweep: ${String(run.json.new_leads ?? 0)} leads. See them: crawlproof intent leads --watch ${id}`),
      );
    }
    case "run": {
      if (!arg) {
        out.error(INTENT_USAGE);
        return 2;
      }
      const { status, json } = await call("POST", `/api/intent/v1/watches/${arg}/run`);
      return done(status, json, () => out.write(`${String(json.new_leads)} new of ${String(json.found)} matching posts (${String(json.searches)} searches).`));
    }
    case "leads": {
      const qs = new URLSearchParams();
      if (str("watch")) qs.set("watch", str("watch")!);
      if (str("tier")) qs.set("tier", str("tier")!);
      if (str("status")) qs.set("status", str("status")!);
      if (str("limit")) qs.set("limit", str("limit")!);
      if (flags.csv && rawGet) {
        qs.set("format", "csv");
        const r = await rawGet(`/api/intent/v1/leads?${qs}`);
        if (r.status >= 400) {
          out.error(`error: ${r.status}`);
          return 1;
        }
        out.write(r.text.trimEnd());
        return 0;
      }
      const { status, json } = await call("GET", `/api/intent/v1/leads?${qs}`);
      return done(status, json, () => {
        const ls = (json.leads ?? []) as Lead[];
        if (!ls.length) out.write("No leads yet.");
        for (const l of ls) out.write(`${String(l.score).padStart(3)} ${l.tier.padEnd(7)} ${l.source.padEnd(9)} ${l.id}  ${l.title}\n    ${l.url}`);
      });
    }
    case "reply": {
      if (!arg) {
        out.error(INTENT_USAGE);
        return 2;
      }
      const { status, json } = await call("POST", `/api/intent/v1/leads/${arg}/reply`, { regenerate: Boolean(flags.regenerate) });
      return done(status, json, () => out.write(String(json.reply)));
    }
    case "status": {
      if (!arg || !arg2) {
        out.error(INTENT_USAGE);
        return 2;
      }
      const { status, json } = await call("PATCH", `/api/intent/v1/leads/${arg}`, { status: arg2 });
      return done(status, json, () => out.write(`Lead ${arg} is now ${arg2}.`));
    }
    default:
      out.error(INTENT_USAGE);
      return 2;
  }
}
