#!/usr/bin/env -S npx tsx
// CrawlProof CLI — stub.
//
// Available commands (more land as the API stabilizes):
//   crawlproof audit <url> [--engine=rule|claude] [--format=markdown|json]
//   crawlproof report <token>
//   crawlproof sweep
//   crawlproof track --project=<uuid> --event=<name>
//   crawlproof stats [site] [--range=1d] [--who=humans]
//   crawlproof help
//
// Currently `audit` runs the rule-based engine locally with no DB/credit
// involvement — handy for local debugging. `report` fetches a public report
// by share-token from the production API.

import { readFileSync } from "node:fs";

import { isAllowedTargetUrl } from "../lib/rateLimit";

type Args = {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
};

export function parseArgs(argv: string[]): Args {
  const [command = "help", ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (rest[i + 1] && !rest[i + 1].startsWith("--")) {
        flags[a.slice(2)] = rest[++i];
      } else {
        flags[a.slice(2)] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { command, positional, flags };
}

async function cmdAudit(args: Args): Promise<number> {
  const url = args.positional[0];
  if (!url) {
    console.error("usage: crawlproof audit <url> [--engine=rule|claude] [--format=markdown|json]");
    return 2;
  }
  const allowed = isAllowedTargetUrl(url);
  if (!allowed.ok) {
    console.error(`Refused: ${allowed.reason}`);
    return 2;
  }

  const engine = (args.flags.engine as string | undefined) ?? "rule";
  const format = (args.flags.format as string | undefined) ?? "markdown";

  console.error(`[cli] auditing ${allowed.url} with ${engine} engine…`);
  const t0 = Date.now();

  if (engine === "claude") {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error("ANTHROPIC_API_KEY is not set — set it in .env or env.");
      return 1;
    }
    const { claudeAudit } = await import("../lib/audit/claude-engine");
    const r = await claudeAudit(allowed.url);
    console.error(`[cli] complete in ${Date.now() - t0}ms · score=${r.score}`);
    if (format === "json") process.stdout.write(JSON.stringify(r, null, 2));
    else process.stdout.write(r.markdown);
    return 0;
  }

  const [{ runAudit }, { toMarkdown }] = await Promise.all([
    import("../lib/audit/engine"),
    import("../lib/audit/markdown"),
  ]);
  const r = await runAudit(allowed.url);
  console.error(`[cli] complete in ${Date.now() - t0}ms · score=${r.score}`);
  if (format === "json") {
    process.stdout.write(
      JSON.stringify({ score: r.score, summary: r.summary, findings: r.findings }, null, 2),
    );
  } else {
    process.stdout.write(toMarkdown({ targetUrl: allowed.url, score: r.score, result: r }));
  }
  return 0;
}

async function cmdReport(args: Args): Promise<number> {
  const token = args.positional[0];
  if (!token) {
    console.error("usage: crawlproof report <share-token>");
    return 2;
  }
  const base = process.env.CRAWLPROOF_SITE_URL ?? "https://crawlproof.com";
  const url = `${base.replace(/\/$/, "")}/r/${token}/report.md`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`fetch ${url} failed: ${res.status} ${res.statusText}`);
    return 1;
  }
  process.stdout.write(await res.text());
  return 0;
}

async function cmdTrack(args: Args): Promise<number> {
  const project =
    (args.flags.project as string | undefined) ?? process.env.CRAWLPROOF_PROJECT;
  if (!project) {
    console.error(
      "usage: crawlproof track --project=<uuid> --event=<name> [--url=<href>] [--target=<label>]",
    );
    console.error("       (or set CRAWLPROOF_PROJECT to skip --project)");
    return 2;
  }
  const event = (args.flags.event as string | undefined) ?? "pageview";
  const pageUrl = args.flags.url as string | undefined;
  const target = args.flags.target as string | undefined;
  const referrer = args.flags.referrer as string | undefined;
  const base =
    (args.flags.base as string | undefined) ??
    process.env.CRAWLPROOF_SITE_URL ??
    "https://crawlproof.com";
  const endpoint = `${base.replace(/\/$/, "")}/api/track`;
  const body: Record<string, unknown> = { site: project, event };
  if (pageUrl) body.url = pageUrl;
  if (target) body.target = target;
  if (referrer) body.referrer = referrer;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok && res.status !== 204) {
    console.error(`track failed: ${res.status} ${res.statusText}`);
    return 1;
  }
  console.error(`[cli] tracked ${event} for project ${project}`);
  return 0;
}

async function cmdSweep(args: Args): Promise<number> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("CRON_SECRET is not set — set it in .env or env.");
    return 2;
  }
  const target = (args.flags.target as string | undefined) ?? "scheduled-audits";
  const ALLOWED: Record<string, string> = {
    "scheduled-audits": "scheduled-audits",
    "autoblog": "lx-autoblog",
    "perf-reports": "perf-reports",
  };
  const path = ALLOWED[target];
  if (!path) {
    console.error(
      `unknown --target: ${target} (expected: scheduled-audits | autoblog | perf-reports)`,
    );
    return 2;
  }
  const base = process.env.CRAWLPROOF_SITE_URL ?? "https://crawlproof.com";
  const url = `${base.replace(/\/$/, "")}/api/cron/${path}`;
  console.error(`[cli] forcing ${path} sweep at ${url} …`);
  const res = await fetch(url, {
    method: "POST",
    headers: { "x-cron-secret": secret, "content-type": "application/json" },
    body: "{}",
  });
  const body = await res.text();
  if (!res.ok) {
    console.error(`sweep failed: ${res.status} ${res.statusText}\n${body}`);
    return 1;
  }
  process.stdout.write(body.endsWith("\n") ? body : body + "\n");
  return 0;
}

// ---------------------------------------------------------------- ads / slots
//
// Both talk to /api/ads/v1/* with a CrawlProof API token (Social → API
// tokens), the same token the MCP server and the myna plugin use.

/**
 * The API token, from the flag, the environment, or ~/.crawlproof.json.
 *
 * The config file is last and exists so that using the CLI is not conditional
 * on remembering to export a secret first. Same shape and same reasoning as
 * ~/.coinpay.json, which `coinpayAuth` below reads.
 */
function apiToken(args: Args): string | null {
  const direct = (args.flags.token as string | undefined) ?? process.env.CRAWLPROOF_TOKEN;
  if (direct && direct.trim()) return direct.trim();

  try {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    const file = process.env.CRAWLPROOF_CONFIG ?? `${home}/.crawlproof.json`;
    const token = (JSON.parse(readFileSync(file, "utf8")) as { token?: string }).token;
    return token && token.trim() ? token.trim() : null;
  } catch {
    return null;
  }
}

function apiBase(args: Args): string {
  const base =
    (args.flags.base as string | undefined) ??
    process.env.CRAWLPROOF_SITE_URL ??
    "https://crawlproof.com";
  return base.replace(/\/$/, "");
}

async function apiCall(
  args: Args,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const token = apiToken(args);
  if (!token) {
    throw new Error("No API token. Set CRAWLPROOF_TOKEN or pass --token (Social → API tokens in the app).");
  }
  const res = await fetch(`${apiBase(args)}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = { error: text.slice(0, 200) };
  }
  return { status: res.status, json };
}

/** The request body `crawlproof ads create` sends, from its flags. Pure, for tests. */
export function campaignBodyFromArgs(args: Args): Record<string, unknown> {
  const body: Record<string, unknown> = { url: args.positional[1] };
  if (typeof args.flags.name === "string") body.name = args.flags.name;
  if (typeof args.flags.budget === "string") body.daily_budget_cents = Number(args.flags.budget);
  if (typeof args.flags.bid === "string") body.bid_credits = Number(args.flags.bid);
  body.status = args.flags.draft ? "draft" : "active";
  return body;
}

/** The request body `crawlproof slots create` sends, from its flags. Pure, for tests. */
export function slotBodyFromArgs(args: Args): Record<string, unknown> {
  const body: Record<string, unknown> = { site: args.positional[1] };
  if (typeof args.flags.placement === "string") body.placement = args.flags.placement;
  if (typeof args.flags.format === "string") body.format = args.flags.format;
  if (typeof args.flags.formats === "string") body.formats = args.flags.formats.split(",").map((f) => f.trim());
  if (args.flags.inactive) body.status = "inactive";
  if (args.flags["no-tracking"]) body.enable_tracking = false;
  return body;
}

async function cmdAds(args: Args): Promise<number> {
  const sub = args.positional[0];
  if (sub === "create") {
    if (!args.positional[1]) {
      console.error("usage: crawlproof ads create <url> [--name=N] [--budget=CENTS] [--bid=CREDITS] [--draft] [--json]");
      return 2;
    }
    const { status, json } = await apiCall(args, "POST", "/api/ads/v1/campaigns", campaignBodyFromArgs(args));
    if (status >= 400) {
      console.error(`ads create failed: ${status} ${json.error ?? ""}`);
      return 1;
    }
    if (args.flags.json) {
      process.stdout.write(`${JSON.stringify(json, null, 2)}\n`);
    } else {
      const existing = json.existing ? " (already existed)" : "";
      process.stdout.write(`${json.status} ${json.ref_slug} ${json.name}${existing}\n  ${json.destination_url}\n  ${json.dashboard_url ?? ""}\n`);
    }
    return 0;
  }
  if (sub === "show" || sub === "pause" || sub === "resume" || sub === "budget" || sub === "delete") {
    const ref = args.positional[1];
    if (!ref) {
      console.error(`usage: crawlproof ads ${sub} <ref-or-id>${sub === "budget" ? " <cents>" : ""}`);
      return 2;
    }
    const path = `/api/ads/v1/campaigns/${encodeURIComponent(ref)}`;
    let method: "GET" | "PATCH" | "DELETE" = "GET";
    let body: Record<string, unknown> | undefined;
    if (sub === "pause") (method = "PATCH"), (body = { status: "paused" });
    if (sub === "resume") (method = "PATCH"), (body = { status: "active" });
    if (sub === "budget") {
      const cents = Number(args.positional[2]);
      if (!Number.isInteger(cents) || cents < 0) {
        console.error("usage: crawlproof ads budget <ref-or-id> <cents per day>");
        return 2;
      }
      (method = "PATCH"), (body = { daily_budget_cents: cents });
    }
    if (sub === "delete") {
      if (!args.flags.yes) {
        console.error("delete removes the campaign and its metering; pass --yes. Pause keeps the history.");
        return 2;
      }
      method = "DELETE";
    }
    const { status, json } = await apiCall(args, method, path, body);
    if (status >= 400) {
      console.error(`ads ${sub} failed: ${status} ${json.error ?? ""}`);
      return 1;
    }
    if (args.flags.json) {
      process.stdout.write(`${JSON.stringify(json, null, 2)}\n`);
      return 0;
    }
    if (sub === "delete") {
      process.stdout.write(`deleted ${json.deleted}\n`);
      return 0;
    }
    const stats = json.stats as Record<string, unknown> | undefined;
    process.stdout.write(`${json.status} ${json.ref_slug} ${json.name}\n  ${json.destination_url}\n  ${json.daily_budget_cents}¢/day, bid ${json.bid_credits ?? "default"}\n`);
    if (stats) {
      const visits = stats.visits as { total: number } | undefined;
      process.stdout.write(
        `  impressions ${stats.impressions} (+${stats.free_impressions} free) · clicks ${stats.clicks} (+${stats.free_clicks} free) · spent ${stats.spent_cents}¢ · visits attributed ${visits?.total ?? 0}\n`,
      );
    }
    return 0;
  }
  if (sub === "list" || sub === undefined) {
    const limit = (args.flags.limit as string | undefined) ?? "20";
    const { status, json } = await apiCall(args, "GET", `/api/ads/v1/campaigns?limit=${encodeURIComponent(limit)}`);
    if (status >= 400) {
      console.error(`ads list failed: ${status} ${json.error ?? ""}`);
      return 1;
    }
    const campaigns = (json.campaigns as Record<string, unknown>[]) ?? [];
    if (args.flags.json) {
      process.stdout.write(`${JSON.stringify(campaigns, null, 2)}\n`);
      return 0;
    }
    if (!campaigns.length) process.stdout.write("No campaigns yet.\n");
    for (const c of campaigns) {
      process.stdout.write(`${String(c.status).padEnd(8)} ${String(c.ref_slug).padEnd(20)} ${c.name}  ${c.destination_url}\n`);
    }
    return 0;
  }
  console.error(`unknown: crawlproof ads ${sub} (expected: create | list | show | pause | resume | budget | delete)`);
  return 2;
}

/**
 * `crawlproof stats [site]` — who arrived, and from where.
 *
 * The question this exists for is "did that post do anything", so the default
 * window is short and the default audience is humans: over a month, with bots
 * counted, a launch is invisible inside the crawler traffic.
 */
async function cmdStats(args: Args): Promise<number> {
  const site = args.positional[0] ?? (args.flags.site as string | undefined) ?? process.env.CRAWLPROOF_PROJECT;
  const range = (args.flags.range as string | undefined) ?? "1d";
  const who = (args.flags.who as string | undefined) ?? "humans";

  const query = new URLSearchParams({ range, who });
  if (site) query.set("site", site);

  const { status, json } = await apiCall(args, "GET", `/api/tracker/v1/stats?${query.toString()}`);
  if (status >= 400) {
    console.error(`error: ${String(json.error ?? status)}`);
    return 1;
  }
  if (args.flags.json) {
    console.log(JSON.stringify(json, null, 2));
    return 0;
  }

  const { renderStats } = await import("../lib/dashboard/stats-text");
  process.stdout.write(renderStats(json as Parameters<typeof renderStats>[0], { range, who }));
  return 0;
}

async function cmdSlots(args: Args): Promise<number> {
  const sub = args.positional[0];
  if (sub === "create") {
    if (!args.positional[1]) {
      console.error("usage: crawlproof slots create <site> [--placement=inline] [--format=text_link] [--formats=a,b] [--inactive] [--no-tracking] [--json]");
      return 2;
    }
    const { status, json } = await apiCall(args, "POST", "/api/ads/v1/slots", slotBodyFromArgs(args));
    if (status >= 400) {
      console.error(`slots create failed: ${status} ${json.error ?? ""}`);
      return 1;
    }
    if (args.flags.json) {
      process.stdout.write(`${JSON.stringify(json, null, 2)}\n`);
    } else {
      const existing = json.existing ? " (already existed)" : "";
      process.stdout.write(`${json.status} slot ${json.id} on ${json.site}${existing}\n\nPaste before </body>:\n\n${json.embed}\n`);
    }
    return 0;
  }
  if (sub === "list" || sub === undefined) {
    const { status, json } = await apiCall(args, "GET", "/api/ads/v1/slots");
    if (status >= 400) {
      console.error(`slots list failed: ${status} ${json.error ?? ""}`);
      return 1;
    }
    const slots = (json.slots as Record<string, unknown>[]) ?? [];
    if (args.flags.json) {
      process.stdout.write(`${JSON.stringify(slots, null, 2)}\n`);
      return 0;
    }
    if (!slots.length) process.stdout.write("No slots yet.\n");
    for (const s of slots) {
      process.stdout.write(`${String(s.status).padEnd(9)} ${s.id}  ${s.site}  ${s.placement}\n`);
    }
    return 0;
  }
  console.error(`unknown: crawlproof slots ${sub} (expected: create | list)`);
  return 2;
}

/**
 * The CoinPay merchant session the finance half of the dashboard needs.
 *
 * Same file `coinpay auth login` writes, because asking someone to paste a JWT
 * they already have on disk is not a login flow. Absent is fine: the dashboard
 * runs without it and says which panels are missing.
 */
function coinpayAuth(args: Args): { token: string; baseUrl: string } | null {
  // CoinPay's SDK wants a base that includes /api, but COINPAY_API_URL is the
  // site origin everywhere else in this repo (it is set that way in the
  // production environment). Accept either and normalise, because the failure
  // otherwise is an HTML page parsed as JSON, which names neither cause.
  const configured = (
    (args.flags["coinpay-url"] as string | undefined) ??
    process.env.COINPAY_API_URL ??
    "https://coinpayportal.com/api"
  ).replace(/\/$/, "");
  const baseUrl = /\/api$/.test(configured) ? configured : `${configured}/api`;

  const fromEnv = process.env.COINPAY_SESSION_TOKEN?.trim();
  if (fromEnv) return { token: fromEnv, baseUrl };

  try {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    const file = process.env.COINPAY_CONFIG ?? `${home}/.coinpay.json`;
    const token = (JSON.parse(readFileSync(file, "utf8")) as { jwtToken?: string }).jwtToken;
    return token ? { token: token.trim(), baseUrl } : null;
  } catch {
    return null;
  }
}

async function cmdDashboard(args: Args): Promise<number> {
  const token = apiToken(args);
  if (!token) {
    console.error("Set CRAWLPROOF_TOKEN (or --token) to a crp_… API token from Social → API tokens.");
    return 2;
  }

  const range = (args.flags.range as string | undefined) ?? "1d";
  const who = (args.flags.who as string | undefined) ?? "humans";
  const only = typeof args.flags.sites === "string" ? args.flags.sites.split(",").map((s) => s.trim()).filter(Boolean) : null;
  const coinpay = args.flags["no-coinpay"] ? null : coinpayAuth(args);

  // --json is the same snapshot the screens render, for a script or a check
  // that cannot open a terminal.
  if (args.flags.json) {
    const { collectDashboard } = await import("../lib/dashboard/collect");
    const { FINANCE_DAYS } = await import("./dashboard");
    const snapshot = await collectDashboard({
      baseUrl: apiBase(args),
      token,
      range,
      who,
      financeDays: FINANCE_DAYS[range] ?? 30,
      concurrency: Number(args.flags.concurrency) || 8,
      coinpay,
      only,
    });
    process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
    return 0;
  }

  if (!process.stdout.isTTY) {
    console.error("The dashboard needs a terminal. Use --json for a snapshot, or `crawlproof stats` for one site.");
    return 2;
  }

  const { runDashboard } = await import("./dashboard");
  await runDashboard({
    baseUrl: apiBase(args),
    token,
    range,
    who,
    interval: Number(args.flags.interval) || 60,
    concurrency: Number(args.flags.concurrency) || 8,
    coinpay,
    only,
    sort: args.flags.sort as string | undefined,
    theme: args.flags.theme as string | undefined,
  });
  return 0;
}

function help() {
  console.log(`crawlproof — AEO audit CLI (stub)

USAGE
  crawlproof <command> [args]

COMMANDS
  audit <url> [--engine=rule|claude] [--format=markdown|json]
      Run an AEO audit on a URL and print the report to stdout.
      --engine=rule    (default) local rule-based engine, no API calls
      --engine=claude  Claude Sonnet 4.6 with web_search + web_fetch
      --format         markdown (default) or json

  report <share-token>
      Fetch a public report by share-token from production.
      Override with CRAWLPROOF_SITE_URL.

  sweep [--target=scheduled-audits|autoblog|perf-reports]
      Force a cron sweep to run now. --target=scheduled-audits (default)
      fires /api/cron/scheduled-audits; --target=autoblog fires
      /api/cron/lx-autoblog; --target=perf-reports fires
      /api/cron/perf-reports. Useful for testing without waiting for the
      hourly pg_cron tick. Requires CRON_SECRET. Override host with
      CRAWLPROOF_SITE_URL.

  track --project=<uuid> [--event=<name>] [--url=<href>] [--target=<label>] [--referrer=<href>]
      Send a stats event to /api/track without the browser script.
      Defaults --event to "pageview". Project id can also come from
      CRAWLPROOF_PROJECT. Override host with CRAWLPROOF_SITE_URL.

  ads create <url> [--name=N] [--budget=CENTS] [--bid=CREDITS] [--draft] [--json]
      Run an ad campaign for a URL: CrawlProof reads the page, writes the
      creatives and starts serving (active unless --draft). A URL that
      already has a live campaign gets that campaign back. Needs an API
      token (CRAWLPROOF_TOKEN, from Social → API tokens).

  ads list [--limit=20] [--json]
      Your campaigns, newest first.

  ads show <ref-or-id> [--json]
      One campaign with its delivery: impressions, clicks, spend, and the
      visits the tracker attributed to it on your own sites.

  ads pause <ref-or-id> | ads resume <ref-or-id> | ads budget <ref-or-id> <cents>
      Change a campaign in place. A ref looks like crawlproof-ad-144.

  ads delete <ref-or-id> --yes
      Remove it, metering included. Pause keeps the history.

  slots create <site> [--placement=inline] [--format=text_link] [--formats=a,b] [--inactive] [--no-tracking] [--json]
      A publisher slot on a site you own, named by hostname or URL. The
      site's project is found or created with the stats tracker on, and
      the output is the two tags to paste before </body>.

  slots list [--json]
      Your slots.

  stats [site] [--range=1h|4h|1d|1w|1m] [--who=humans|bots|all] [--json]
      Who arrived and from where: sources, referrers and top pages. Defaults
      to the last day and humans only, because a launch is invisible inside a
      month of crawler traffic. The site is a hostname, a project id or a
      project name; with one project it can be left out. Needs an API token.

  dashboard [--range=1h|4h|1d|1w|1m] [--who=humans|bots|all] [--interval=60]
            [--sites=a.com,b.com] [--sort=score|visitors|pageviews]
            [--concurrency=8] [--no-coinpay] [--json]
      A live terminal dashboard of what the fleet costs and what it returns:
      traffic across every site you own, ad delivery, and — when a CoinPay
      merchant session is on the box — the bank feed behind it. Five screens:
      ROI, Traffic, Ads, Money, Spend. Needs an API token and a terminal;
      --json prints the same snapshot for a script. Aliases: roi, tui.

      On Traffic, ↑/↓ pick a property and Enter (or a click) opens it: that
      domain's traffic and money on their own, with its risk-to-viral score
      broken into the parts it was built from. Esc / ← / 2 comes back, s
      cycles the order. The score is
        100 × viral × (1 − risk/2), viral = momentum .40 + discovery .30 +
        humanity .20 + money .10, risk = volatility .40 + concentration .30 +
        bot dependence .20 + unmonetised .10.
      A component with no data is dropped, not counted as zero; ~ marks a
      sample under 25 human visits.

  help
      Print this message.

ENV
  ANTHROPIC_API_KEY      Required for --engine=claude.
  CRAWLPROOF_SITE_URL    Override the API base URL for 'report', 'sweep', 'track', 'ads' and 'slots'.
  CRAWLPROOF_PROJECT     Default project UUID for 'track'.
  CRAWLPROOF_TOKEN       API token (crp_…) for 'ads', 'slots', 'stats' and
                         'dashboard'; --token overrides. Falls back to the
                         'token' field of ~/.crawlproof.json.
  COINPAY_SESSION_TOKEN  CoinPay merchant JWT for the money half of
                         'dashboard'. Defaults to jwtToken in ~/.coinpay.json,
                         which 'coinpay auth login' writes.
  COINPAY_API_URL        CoinPay API base (default https://coinpayportal.com/api).
  CRON_SECRET            Required for 'sweep'.

EXAMPLES
  crawlproof audit https://crawlproof.com
  crawlproof audit https://example.com --engine=claude --format=json > report.json
  crawlproof report r-ceiZSv2VnqypqUfjLwtrV0
  CRAWLPROOF_SITE_URL=http://localhost:3000 crawlproof sweep
  CRAWLPROOF_SITE_URL=http://localhost:3000 crawlproof sweep --target=autoblog
  crawlproof track --project=ac4e0a7d-... --event=signup --target=hero_cta
  CRAWLPROOF_TOKEN=crp_... crawlproof ads create https://nichedb.dev --name "NicheDB"
  CRAWLPROOF_TOKEN=crp_... crawlproof slots create nichedb.dev
  CRAWLPROOF_TOKEN=crp_... crawlproof dashboard --range=1w
  CRAWLPROOF_TOKEN=crp_... crawlproof dashboard --json | jq .roi.derived
  CRAWLPROOF_TOKEN=crp_... crawlproof dashboard --json | jq '.sites[] | {site, score: .score.score}'
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    switch (args.command) {
      case "audit":
        return await cmdAudit(args);
      case "report":
        return await cmdReport(args);
      case "sweep":
        return await cmdSweep(args);
      case "track":
        return await cmdTrack(args);
      case "ads":
        return await cmdAds(args);
      case "slots":
        return await cmdSlots(args);
      case "stats":
        return await cmdStats(args);
      case "dashboard":
      case "roi":
      case "tui":
        return await cmdDashboard(args);
      case "help":
      case "--help":
      case "-h":
        help();
        return 0;
      default:
        console.error(`unknown command: ${args.command}`);
        help();
        return 2;
    }
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

// Only auto-execute when invoked directly (not when imported by tests).
const invokedAs = process.argv[1] ?? "";
if (invokedAs.endsWith("/cli/index.ts") || invokedAs.endsWith("cli/index.js")) {
  main().then((code) => process.exit(code ?? 0));
}

export { main };

