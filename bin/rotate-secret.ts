#!/usr/bin/env -S npx tsx
//
// Generate a fresh random secret, write it to .env (replacing the
// existing entry or appending a new one), and push it to Railway via
// stdin — without ever echoing the value to stdout.
//
// Usage:
//   npm run rotate-secret -- SOCIAL_VAULT_KEY
//   npm run rotate-secret -- CRON_SECRET --bytes 48
//   npm run rotate-secret -- FOO --service <service-id> --environment <env-id>
//
// Both .env and Railway end up with the same value. The script never
// prints the value to stdout, so logs / pasted-into-chat output don't
// leak the secret. (If you want to *view* the value, read .env — it's
// only on your machine.)
//
// Railway resolution:
//   --service / --environment flags win, then `railway status --json`
//   for the currently-linked project.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";

type Args = {
  name: string;
  bytes: number;
  envPath: string;
  service?: string;
  environment?: string;
  skipRailway: boolean;
  skipEnv: boolean;
};

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] && !argv[i + 1].startsWith("--")) {
        flags[a.slice(2)] = argv[++i];
      } else {
        flags[a.slice(2)] = true;
      }
    } else {
      positional.push(a);
    }
  }
  const name = positional[0];
  if (!name || !/^[A-Z][A-Z0-9_]*$/.test(name)) {
    console.error(
      "usage: rotate-secret <NAME> [--bytes 32] [--env-path .env] [--service ID] [--environment ID] [--skip-railway] [--skip-env]",
    );
    console.error("       NAME must be UPPER_SNAKE_CASE.");
    process.exit(2);
  }
  return {
    name,
    bytes: Number(flags.bytes ?? 32),
    envPath: String(flags["env-path"] ?? ".env"),
    service: typeof flags.service === "string" ? flags.service : undefined,
    environment:
      typeof flags.environment === "string" ? flags.environment : undefined,
    skipRailway: flags["skip-railway"] === true,
    skipEnv: flags["skip-env"] === true,
  };
}

function generate(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 16 || bytes > 256) {
    console.error("--bytes must be 16..256");
    process.exit(2);
  }
  return crypto.randomBytes(bytes).toString("base64");
}

function updateEnvFile(envPath: string, name: string, value: string): {
  action: "replaced" | "appended" | "created";
} {
  const abs = path.resolve(envPath);
  if (!fs.existsSync(abs)) {
    fs.writeFileSync(abs, `${name}=${value}\n`, { mode: 0o600 });
    return { action: "created" };
  }
  const src = fs.readFileSync(abs, "utf8");
  const lines = src.split(/\r?\n/);
  let replaced = false;
  const out = lines.map((line) => {
    if (line.startsWith(`${name}=`)) {
      replaced = true;
      return `${name}=${value}`;
    }
    return line;
  });
  if (!replaced) {
    if (out.length > 0 && out[out.length - 1] === "") out.pop();
    out.push(`${name}=${value}`);
    out.push("");
  }
  fs.writeFileSync(abs, out.join("\n"), { mode: 0o600 });
  return { action: replaced ? "replaced" : "appended" };
}

function pushToRailway(args: Args, value: string): { ok: boolean; reason?: string } {
  const cliArgs = ["variable", "set", "--stdin", args.name];
  if (args.service) cliArgs.push("--service", args.service);
  if (args.environment) cliArgs.push("--environment", args.environment);

  const child = spawn("railway", cliArgs, {
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.write(value);
  child.stdin.end();

  let stderr = "";
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  child.stdout.on("data", () => {}); // drop stdout

  return new Promise<{ ok: boolean; reason?: string }>((resolve) => {
    child.on("close", (code) => {
      if (code === 0) resolve({ ok: true });
      else
        resolve({
          ok: false,
          reason: stderr.trim() || `railway exited ${code}`,
        });
    });
    child.on("error", (err) => resolve({ ok: false, reason: err.message }));
  }) as unknown as { ok: boolean; reason?: string };
}

function verifyOnRailway(args: Args): { found: boolean; length?: number; reason?: string } {
  const cliArgs = ["variable", "list", "--json"];
  if (args.service) cliArgs.push("--service", args.service);
  if (args.environment) cliArgs.push("--environment", args.environment);
  const r = spawnSync("railway", cliArgs, { encoding: "utf8" });
  if (r.status !== 0) {
    return { found: false, reason: r.stderr?.trim() || "railway list failed" };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(r.stdout) as Record<string, unknown>;
  } catch {
    return { found: false, reason: "could not parse railway list JSON" };
  }
  const v = parsed[args.name];
  if (typeof v !== "string") return { found: false };
  return { found: true, length: v.length };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const value = generate(args.bytes);

  let envAction: string | null = null;
  if (!args.skipEnv) {
    const r = updateEnvFile(args.envPath, args.name, value);
    envAction = r.action;
  }

  let railwayOk: boolean | null = null;
  let railwayLen: number | null = null;
  let railwayReason: string | undefined;
  if (!args.skipRailway) {
    const push = (await Promise.resolve(pushToRailway(args, value))) as {
      ok: boolean;
      reason?: string;
    };
    railwayOk = push.ok;
    railwayReason = push.reason;
    if (push.ok) {
      const verify = verifyOnRailway(args);
      railwayLen = verify.length ?? null;
    }
  }

  // Status summary. NEVER print the value.
  console.log(`secret: ${args.name}`);
  console.log(`size:   ${args.bytes} bytes → ${value.length} base64 chars`);
  if (envAction)
    console.log(`.env:   ${envAction} (${path.resolve(args.envPath)})`);
  else console.log(`.env:   skipped`);
  if (railwayOk === null) console.log(`railway: skipped`);
  else if (railwayOk)
    console.log(`railway: set${railwayLen != null ? ` (verified, len=${railwayLen})` : ""}`);
  else console.log(`railway: FAILED — ${railwayReason}`);
}

main().catch((err) => {
  console.error("rotate-secret crashed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
