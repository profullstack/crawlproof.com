#!/usr/bin/env -S npx tsx
// CrawlProof CLI — stub.
//
// Available commands (more land as the API stabilizes):
//   crawlproof audit <url> [--engine=rule|claude] [--format=markdown|json]
//   crawlproof report <token>
//   crawlproof sweep
//   crawlproof help
//
// Currently `audit` runs the rule-based engine locally with no DB/credit
// involvement — handy for local debugging. `report` fetches a public report
// by share-token from the production API.

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

async function cmdSweep(args: Args): Promise<number> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("CRON_SECRET is not set — set it in .env or env.");
    return 2;
  }
  const target = (args.flags.target as string | undefined) ?? "scheduled-audits";
  const path = target === "autoblog" ? "lx-autoblog" : "scheduled-audits";
  if (target !== "autoblog" && target !== "scheduled-audits") {
    console.error(`unknown --target: ${target} (expected: scheduled-audits | autoblog)`);
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

  sweep [--target=scheduled-audits|autoblog]
      Force a cron sweep to run now. --target=scheduled-audits (default)
      fires /api/cron/scheduled-audits; --target=autoblog fires
      /api/cron/lx-autoblog. Useful for testing without waiting for the
      hourly pg_cron tick. Requires CRON_SECRET. Override host with
      CRAWLPROOF_SITE_URL.

  help
      Print this message.

ENV
  ANTHROPIC_API_KEY      Required for --engine=claude.
  CRAWLPROOF_SITE_URL    Override the API base URL for 'report' and 'sweep'.
  CRON_SECRET            Required for 'sweep'.

EXAMPLES
  crawlproof audit https://crawlproof.com
  crawlproof audit https://example.com --engine=claude --format=json > report.json
  crawlproof report r-ceiZSv2VnqypqUfjLwtrV0
  CRAWLPROOF_SITE_URL=http://localhost:3000 crawlproof sweep
  CRAWLPROOF_SITE_URL=http://localhost:3000 crawlproof sweep --target=autoblog
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

