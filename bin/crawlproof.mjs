#!/usr/bin/env node
// The `crawlproof` entry point.
//
// The CLI is TypeScript inside a Next.js app rather than a built package, so
// running it means running tsx against cli/index.ts. Everything here is about
// finding the repo and the right tsx no matter where the caller stood, because
// the alternative — telling people to cd into a checkout and type
// `npm run cli --` — is a setup step, and those do not survive contact.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const entry = join(repo, "cli", "index.ts");

if (!existsSync(entry)) {
  console.error(`crawlproof: cannot find ${entry}`);
  console.error("The launcher must sit in bin/ inside the crawlproof.com checkout.");
  process.exit(1);
}

// Prefer the checkout's own tsx; fall back to npx so a fresh clone still runs.
const localTsx = join(repo, "node_modules", ".bin", "tsx");
const [cmd, prefix] = existsSync(localTsx) ? [localTsx, []] : ["npx", ["--yes", "tsx"]];

const child = spawn(cmd, [...prefix, entry, ...process.argv.slice(2)], {
  cwd: repo,
  stdio: "inherit",
  env: process.env,
});

child.on("error", (err) => {
  console.error(`crawlproof: could not start tsx (${err.message})`);
  console.error(`Run \`npm install\` in ${repo}.`);
  process.exit(1);
});

// Relay the child's fate rather than inventing one: a TUI killed by ctrl+c
// should not look like a clean exit to whatever called this.
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
