// @profullstack/crawlproof — the read side of CrawlProof, on any box.
//
// Two commands, both token-authed and both pure HTTP, which is exactly why
// they can be published while the rest of the CLI cannot: `audit` needs the
// audit engines and their model SDKs, and `sweep` needs a cron secret. Those
// stay in the repo. What a box wants is to look, and that is this.
//
// The modules underneath are the same files the in-repo CLI runs and the same
// ones the test suite covers; this file is bundled from them rather than being
// a second copy of them.

import { readFileSync } from "node:fs";

import { collectDashboard } from "../../../lib/dashboard/collect";
import { renderStats } from "../../../lib/dashboard/stats-text";
import { FINANCE_DAYS, runDashboard } from "../../../cli/dashboard";

export const VERSION = "0.2.0";

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
    const a = rest[i] as string;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (rest[i + 1] && !(rest[i + 1] as string).startsWith("--")) flags[a.slice(2)] = rest[++i] as string;
      else flags[a.slice(2)] = true;
    } else {
      positional.push(a);
    }
  }
  return { command, positional, flags };
}

/** Read one field out of a JSON config, or nothing at all if it is not there. */
function fromConfig(file: string, field: string): string | null {
  try {
    const value = (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>)[field];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

const home = () => process.env.HOME ?? process.env.USERPROFILE ?? "";

const num = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

export function apiToken(args: Args): string | null {
  const direct = (args.flags.token as string | undefined) ?? process.env.CRAWLPROOF_TOKEN;
  if (direct && direct.trim()) return direct.trim();
  return fromConfig(process.env.CRAWLPROOF_CONFIG ?? `${home()}/.crawlproof.json`, "token");
}

export function apiBase(args: Args): string {
  const base =
    (args.flags.base as string | undefined) ?? process.env.CRAWLPROOF_SITE_URL ?? "https://crawlproof.com";
  return base.replace(/\/$/, "");
}

/**
 * The CoinPay merchant session, if this box has one.
 *
 * COINPAY_API_URL is the site origin in CrawlProof's environment but the
 * CoinPay SDK's base must include /api. Accept either: the failure otherwise
 * is an HTML page parsed as JSON, which names neither cause.
 */
export function coinpayAuth(args: Args): { token: string; baseUrl: string } | null {
  const configured = (
    (args.flags["coinpay-url"] as string | undefined) ??
    process.env.COINPAY_API_URL ??
    "https://coinpayportal.com/api"
  ).replace(/\/$/, "");
  const baseUrl = /\/api$/.test(configured) ? configured : `${configured}/api`;

  const token =
    process.env.COINPAY_SESSION_TOKEN?.trim() ||
    fromConfig(process.env.COINPAY_CONFIG ?? `${home()}/.coinpay.json`, "jwtToken");
  return token ? { token, baseUrl } : null;
}

const USAGE = `crawlproof — what the fleet costs and what it returns

USAGE
  crawlproof <command> [options]

COMMANDS
  dashboard [--range=1h|4h|1d|1w|1m] [--who=humans|bots|all] [--interval=60]
            [--sites=a.com,b.com] [--concurrency=8] [--no-coinpay] [--json]
      A live dashboard of traffic across every site on the account, ad
      delivery, and — when a CoinPay merchant session is on the box — the bank
      feed behind it. Five screens: ROI, Traffic, Ads, Money, Spend.
      Aliases: roi, tui. --json prints the same snapshot for a script.

  stats [site] [--range=1h|4h|1d|1w|1m] [--who=humans|bots|all] [--json]
      Who arrived and from where: sources, referrers and top pages. Defaults
      to the last day and humans only, because a launch is invisible inside a
      month of crawler traffic. With one project the site can be left out.

  ad <url> [--name=N] [--budget=CENTS] [--bid=CREDITS] [--draft] [--json]
      Run an ad for a URL. CrawlProof reads the page, writes the creatives and
      starts serving. A URL that already has a live campaign gets that campaign
      back, so running it twice is safe.

  Ad network targets on the Ads screen default to 3,000,000 impressions a
  month at 5% CTR. Override with --target-impressions=N and --target-ctr=5.

  ads [list] [--limit=20] [--json]
  ads show|pause|resume <ref-or-id>
  ads budget <ref-or-id> <cents-per-day>
  ads delete <ref-or-id> --yes
      Look at and change what is running. A ref looks like crawlproof-ad-144.

  help | version

AUTH
  CRAWLPROOF_TOKEN       API token (crp_…) from Social → API tokens, or the
                         "token" field of ~/.crawlproof.json. --token wins.
  CRAWLPROOF_SITE_URL    Override the API base (default https://crawlproof.com).
  COINPAY_SESSION_TOKEN  CoinPay merchant JWT for the money screens. Defaults
                         to jwtToken in ~/.coinpay.json, which
                         'coinpay auth login' writes. Without it the traffic
                         and ads screens still work.

The dashboard needs Node 22.6+ and a terminal; --json needs neither.
`;

async function cmdStats(args: Args): Promise<number> {
  const token = apiToken(args);
  if (!token) {
    console.error("Set CRAWLPROOF_TOKEN, or put a token in ~/.crawlproof.json.");
    return 2;
  }
  const site = args.positional[0] ?? (args.flags.site as string | undefined) ?? process.env.CRAWLPROOF_PROJECT;
  const range = (args.flags.range as string | undefined) ?? "1d";
  const who = (args.flags.who as string | undefined) ?? "humans";

  const query = new URLSearchParams({ range, who });
  if (site) query.set("site", site);

  const res = await fetch(`${apiBase(args)}/api/tracker/v1/stats?${query.toString()}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    console.error(`error: ${String(json.error ?? res.status)}`);
    return 1;
  }
  if (args.flags.json) {
    console.log(JSON.stringify(json, null, 2));
    return 0;
  }
  process.stdout.write(renderStats(json as Parameters<typeof renderStats>[0], { range, who }));
  return 0;
}

async function cmdDashboard(args: Args): Promise<number> {
  const token = apiToken(args);
  if (!token) {
    console.error("Set CRAWLPROOF_TOKEN, or put a token in ~/.crawlproof.json.");
    return 2;
  }
  const range = (args.flags.range as string | undefined) ?? "1d";
  const who = (args.flags.who as string | undefined) ?? "humans";
  const only =
    typeof args.flags.sites === "string"
      ? args.flags.sites.split(",").map((s) => s.trim()).filter(Boolean)
      : null;
  const coinpay = args.flags["no-coinpay"] ? null : coinpayAuth(args);
  const baseUrl = apiBase(args);

  if (args.flags.json) {
    const snapshot = await collectDashboard({
      baseUrl,
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
    console.error("The dashboard needs a terminal. Use --json for a snapshot, or `crawlproof stats`.");
    return 2;
  }

  await runDashboard({
    baseUrl,
    token,
    range,
    who,
    ...(Number(args.flags["target-impressions"]) > 0
      ? { targetImpressions: Number(args.flags["target-impressions"]) }
      : {}),
    // Given as a percentage, kept as a fraction: nobody types 0.05 for 5%.
    ...(Number(args.flags["target-ctr"]) > 0 ? { targetCtr: Number(args.flags["target-ctr"]) / 100 } : {}),
    interval: Number(args.flags.interval) || 60,
    concurrency: Number(args.flags.concurrency) || 8,
    coinpay,
    only,
    theme: args.flags.theme as string | undefined,
  });
  return 0;
}


/** One authenticated call against the CrawlProof API. */
async function apiCall(
  args: Args,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const token = apiToken(args);
  if (!token) return { status: 401, json: { error: "no API token" } };
  const res = await fetch(`${apiBase(args)}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = { error: `${res.status} ${res.statusText}: not JSON` };
  }
  return { status: res.status, json };
}

/** The body `crawlproof ad` sends. Pure, so the flag handling is testable. */
export function campaignBody(url: string, args: Args): Record<string, unknown> {
  const body: Record<string, unknown> = { url };
  if (typeof args.flags.name === "string") body.name = args.flags.name;
  if (typeof args.flags.budget === "string") body.daily_budget_cents = Number(args.flags.budget);
  if (typeof args.flags.bid === "string") body.bid_credits = Number(args.flags.bid);
  // Active unless asked otherwise: `ad <url>` is a verb, and a campaign that
  // does not run is not what the word means.
  body.status = args.flags.draft ? "draft" : "active";
  return body;
}

/**
 * `crawlproof ad <url>` — read the page, write the creatives, start serving.
 *
 * The whole point is that it is one word and one URL. A URL that already has a
 * live campaign gets that campaign back rather than a twin, so running it twice
 * is safe.
 */
async function cmdAd(args: Args): Promise<number> {
  const url = args.positional[0];
  if (!url) {
    console.error("usage: crawlproof ad <url> [--name=N] [--budget=CENTS] [--bid=CREDITS] [--draft] [--json]");
    return 2;
  }
  const { status, json } = await apiCall(args, "POST", "/api/ads/v1/campaigns", campaignBody(url, args));
  if (status >= 400) {
    console.error(`ad failed: ${status} ${json.error ?? ""}`);
    return 1;
  }
  if (args.flags.json) {
    process.stdout.write(`${JSON.stringify(json, null, 2)}\n`);
    return 0;
  }
  const existing = json.existing ? " (already running)" : "";
  process.stdout.write(
    `${json.status} ${json.ref_slug} ${json.name}${existing}\n  ${json.destination_url}\n  ${json.dashboard_url ?? ""}\n`,
  );
  return 0;
}

async function cmdAds(args: Args): Promise<number> {
  const sub = args.positional[0] ?? "list";

  if (sub === "list") {
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
    if (!campaigns.length) {
      process.stdout.write("No campaigns yet. `crawlproof ad <url>` starts one.\n");
      return 0;
    }
    for (const c of campaigns) {
      process.stdout.write(`${String(c.status).padEnd(9)} ${c.ref_slug}  ${c.name}\n`);
    }
    return 0;
  }

  const ref = args.positional[1];
  if (!["show", "pause", "resume", "budget", "delete"].includes(sub)) {
    console.error(`unknown: crawlproof ads ${sub}`);
    return 2;
  }
  if (!ref) {
    console.error(`usage: crawlproof ads ${sub} <ref-or-id>${sub === "budget" ? " <cents>" : ""}`);
    return 2;
  }

  const path = `/api/ads/v1/campaigns/${encodeURIComponent(ref)}`;
  let method: "GET" | "PATCH" | "DELETE" = "GET";
  let body: Record<string, unknown> | undefined;
  if (sub === "pause") ((method = "PATCH"), (body = { status: "paused" }));
  if (sub === "resume") ((method = "PATCH"), (body = { status: "active" }));
  if (sub === "budget") {
    const cents = Number(args.positional[2]);
    if (!Number.isInteger(cents) || cents < 0) {
      console.error("usage: crawlproof ads budget <ref-or-id> <cents per day>");
      return 2;
    }
    ((method = "PATCH"), (body = { daily_budget_cents: cents }));
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
  process.stdout.write(`${json.status} ${json.ref_slug} ${json.name}\n  ${json.destination_url}\n`);
  if (stats) {
    // Free delivery first: on a network running entirely on free backfill the
    // paid columns are zero, and leading with them reads as "nothing happened".
    const visits = stats.visits as { total?: number } | undefined;
    process.stdout.write(
      `  ${num(stats.free_impressions) + num(stats.impressions)} impressions (${num(stats.free_impressions)} free) · ` +
        `${num(stats.free_clicks) + num(stats.clicks)} clicks (${num(stats.free_clicks)} free) · ` +
        `${num(stats.spent_cents)}\u00a2 spent · ${visits?.total ?? 0} visits attributed\n`,
    );
  }
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  try {
    switch (args.command) {
      case "dashboard":
      case "roi":
      case "tui":
        return await cmdDashboard(args);
      case "stats":
        return await cmdStats(args);
      case "ad":
        return await cmdAd(args);
      case "ads":
        return await cmdAds(args);
      case "version":
      case "--version":
      case "-v":
        process.stdout.write(`${VERSION}\n`);
        return 0;
      case "help":
      case "--help":
      case "-h":
        process.stdout.write(USAGE);
        return 0;
      default:
        console.error(`unknown command: ${args.command}`);
        process.stdout.write(USAGE);
        return 2;
    }
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
