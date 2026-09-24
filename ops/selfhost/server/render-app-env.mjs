#!/usr/bin/env node
//
// Build /home/anthony/www/crawlproof.com/app.env from three inputs:
//
//   1. the Railway export      (every app secret as it runs today)
//   2. crawlproof-connection.env (the self-hosted Supabase keys)
//   3. the overrides below     (what has to change because the host changed)
//
// Run on dev2. Writes 0600. The Railway export is the only thing that has to
// be copied onto the box, and it should be deleted once this has run.
//
// Usage:
//   node render-app-env.mjs <railway-vars.json> [--out /path/app.env] [--print]
//
// --print lists the keys and where each value came from, never the values.

import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const varsFile = args.find((a) => !a.startsWith('--'));
const outIdx = args.indexOf('--out');
const OUT = outIdx >= 0 ? args[outIdx + 1] : '/home/anthony/www/crawlproof.com/app.env';
const CONN = process.env.CONN_ENV || '/home/anthony/www/crawlproof.com/supabase/crawlproof-connection.env';
const printOnly = args.includes('--print');

if (!varsFile) {
  console.error('usage: render-app-env.mjs <railway-vars.json> [--out path] [--print]');
  process.exit(1);
}

// ---- 1. Railway export. Accepts either the raw GraphQL response or a
//         plain {KEY: value} object, so it works with `railway variables
//         --json` as well as an API dump.
const raw = JSON.parse(readFileSync(varsFile, 'utf8'));
const railway = raw?.data?.variables ?? raw;

// Railway injects one RAILWAY_SERVICE_<NAME>_URL for every service in the
// shared project (56 of them here) plus its own metadata. None of it means
// anything off Railway.
const railwayNoise = /^RAILWAY_/;

// ---- 2. the self-hosted Supabase keys
function parseEnvFile(path) {
  const out = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
const conn = parseEnvFile(CONN);

for (const k of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) {
  if (!conn[k]) {
    console.error(`ERROR: ${CONN} has no ${k} — run setup-supabase.sh first`);
    process.exit(1);
  }
}

// ---- 3. what changes because the host changed
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || '';
if (!REDIS_PASSWORD) {
  console.error('ERROR: set REDIS_PASSWORD (the same one docker-compose.app.yml uses)');
  process.exit(1);
}

const overrides = {
  // Supabase now answers on our own gateway.
  NEXT_PUBLIC_SUPABASE_URL: conn.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: conn.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: conn.SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_DB_PASSWORD: conn.SELFHOST_POSTGRES_PASSWORD,

  // Redis moved off redis.railway.internal. The app reaches it through the
  // host gateway because the app and the Supabase stack are separate compose
  // projects and are deliberately not on one network.
  REDIS_URL: `redis://default:${REDIS_PASSWORD}@host.docker.internal:6379`,

  // The worker still runs beside the app inside the same container.
  WORKER_URL: 'http://127.0.0.1:9080',
  WORKER_PORT: '9080',

  NEXT_PUBLIC_SITE_URL: 'https://crawlproof.com',
};

const merged = {};
for (const [k, v] of Object.entries(railway)) {
  if (railwayNoise.test(k)) continue;
  merged[k] = v;
}
const source = {};
for (const k of Object.keys(merged)) source[k] = 'railway';
for (const [k, v] of Object.entries(overrides)) {
  source[k] = k in merged ? 'override (was railway)' : 'override (new)';
  merged[k] = v;
}

if (printOnly) {
  const keys = Object.keys(merged).sort();
  console.log(`${keys.length} keys\n`);
  for (const k of keys) console.log(`  ${k.padEnd(38)} ${source[k]}`);
  process.exit(0);
}

// GITHUB_APP_PRIVATE_KEY is a PEM and carries real newlines, and lib/env.ts
// reads it straight out of process.env expecting them (it does no \n
// unescaping). An unquoted multi-line value makes docker compose fail the
// whole file with `unexpected character "+" in variable name`, naming the
// second line of the PEM. Compose keeps real newlines inside a double-quoted
// value, so quote anything multi-line and escape what would end the quote.
const encode = (v) => {
  const s = String(v ?? '');
  if (!/[\n\r"]/.test(s)) return s;
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
};

const body = Object.keys(merged)
  .sort()
  .map((k) => `${k}=${encode(merged[k])}`)
  .join('\n');

writeFileSync(OUT, `# crawlproof app env, rendered by render-app-env.mjs on ${new Date().toISOString()}\n${body}\n`, {
  mode: 0o600,
});
console.log(`wrote ${OUT} with ${Object.keys(merged).length} keys`);
console.log(`overridden: ${Object.keys(overrides).join(', ')}`);
