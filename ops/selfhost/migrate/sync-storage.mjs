#!/usr/bin/env node
//
// Copy every Storage object from the crawlproof Supabase CLOUD project into
// the self-hosted stack, keeping bucket and path identical so the public URLs
// differ only in host.
//
// Uploads go through the Storage API rather than straight onto the disk the
// storage service mounts: the API is what writes storage.objects, and rows
// written by hand would describe files the backend cannot serve.
//
// Usage:
//   CLOUD_URL=https://<ref>.supabase.co \
//   CLOUD_SERVICE_KEY=... \
//   SELF_URL=https://supabase.crawlproof.com \
//   SELF_SERVICE_KEY=... \
//   node ops/selfhost/migrate/sync-storage.mjs <dumpdir> [--concurrency 8] [--dry-run]
//
// Resumable: an object already present in the destination with the same size
// is skipped, so a re-run after a failure only moves what is missing.

import { readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const dump = args.find((a) => !a.startsWith('--'));
const dryRun = args.includes('--dry-run');
const concurrency = Number(
  (args.find((a) => a.startsWith('--concurrency')) || '--concurrency=8').split('=')[1] ||
    args[args.indexOf('--concurrency') + 1] ||
    8,
);

const CLOUD_URL = (process.env.CLOUD_URL || '').replace(/\/$/, '');
const CLOUD_SERVICE_KEY = process.env.CLOUD_SERVICE_KEY || '';
const SELF_URL = (process.env.SELF_URL || '').replace(/\/$/, '');
const SELF_SERVICE_KEY = process.env.SELF_SERVICE_KEY || '';

if (!dump) die('usage: sync-storage.mjs <dumpdir>');
for (const [k, v] of Object.entries({ CLOUD_URL, CLOUD_SERVICE_KEY, SELF_URL, SELF_SERVICE_KEY })) {
  if (!v) die(`missing env: ${k}`);
}

function die(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

const inventory = readFileSync(join(dump, 'storage-inventory.tsv'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const [bucket, isPublic, name, size, mime] = line.split('\t');
    return { bucket, public: isPublic === 't', name, size: Number(size || 0), mime };
  });

const failLog = join(dump, 'storage-sync-failures.log');
const totalBytes = inventory.reduce((n, o) => n + o.size, 0);
console.log(
  `${inventory.length} objects, ${(totalBytes / 1024 ** 3).toFixed(2)} GB, concurrency ${concurrency}${dryRun ? ' (dry run)' : ''}`,
);

let done = 0;
let skipped = 0;
let failed = 0;
let movedBytes = 0;
const started = Date.now();

async function headSelf(o) {
  // A HEAD through the authenticated object path works for public and private
  // buckets alike, so resume does not depend on the bucket being public.
  const res = await fetch(`${SELF_URL}/storage/v1/object/${o.bucket}/${encodeURI(o.name)}`, {
    method: 'HEAD',
    headers: { Authorization: `Bearer ${SELF_SERVICE_KEY}` },
  });
  if (!res.ok) return null;
  return Number(res.headers.get('content-length') || 0);
}

async function downloadCloud(o) {
  const res = await fetch(`${CLOUD_URL}/storage/v1/object/${o.bucket}/${encodeURI(o.name)}`, {
    headers: { Authorization: `Bearer ${CLOUD_SERVICE_KEY}` },
  });
  if (!res.ok) throw new Error(`download ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function uploadSelf(o, body) {
  // x-upsert makes a re-run idempotent instead of 409-ing on what is already there.
  const res = await fetch(`${SELF_URL}/storage/v1/object/${o.bucket}/${encodeURI(o.name)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SELF_SERVICE_KEY}`,
      'Content-Type': o.mime || 'application/octet-stream',
      'x-upsert': 'true',
    },
    body,
  });
  if (!res.ok) throw new Error(`upload ${res.status} ${(await res.text()).slice(0, 200)}`);
}

async function one(o) {
  try {
    const existing = await headSelf(o);
    if (existing !== null && existing === o.size && o.size > 0) {
      skipped += 1;
      return;
    }
    if (dryRun) return;
    const body = await downloadCloud(o);
    await uploadSelf(o, body);
    movedBytes += o.size;
  } catch (err) {
    failed += 1;
    appendFileSync(failLog, `${o.bucket}\t${o.name}\t${err.message}\n`);
  } finally {
    done += 1;
    if (done % 100 === 0 || done === inventory.length) {
      const secs = (Date.now() - started) / 1000;
      console.log(
        `${done}/${inventory.length} moved=${(movedBytes / 1024 ** 3).toFixed(2)}GB skipped=${skipped} failed=${failed} ${(done / secs).toFixed(1)}/s`,
      );
    }
  }
}

// Fixed pool of workers pulling from one shared cursor — a Promise.all over
// chunks would stall every worker on the slowest object in each chunk.
let cursor = 0;
async function worker() {
  while (cursor < inventory.length) {
    const o = inventory[cursor++];
    await one(o);
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));

console.log(
  `\ndone: ${done} objects, ${(movedBytes / 1024 ** 3).toFixed(2)} GB moved, ${skipped} already present, ${failed} failed`,
);
if (failed) {
  console.log(`failures logged to ${failLog} — re-run to retry just those`);
  process.exit(1);
}
