// Railway-side bridge between the port_scans table and the DO-droplet prober
// (uptime-monitoring-prd.md §12). The web UI inserts a `queued` port_scans row;
// this module (run from worker/index.ts on a short interval) enqueues a BullMQ
// job to the "prober" queue, then reconciles finished jobs back into the DB.
//
// The droplet writes no DB — it returns the result as the job's return value,
// which we read here and persist (scan row + findings). Keeps Supabase creds
// off the droplet.
import { Queue, type ConnectionOptions, type Job } from "bullmq";
import type { SupabaseClient } from "@supabase/supabase-js";
import { PROBER_QUEUE, type PortScanResult } from "./prober";

// Ports that are alarming when publicly exposed (databases, caches, admin, etc.).
const HIGH_RISK_PORTS = new Set([
  1433, 1521, 2379, 3306, 3389, 5432, 5433, 5984, 6379, 6380, 9200, 9300,
  11211, 27017, 27018,
]);
const LOW_RISK_PORTS = new Set([80, 443]);

// A running scan older than this is treated as timed out.
const RUNNING_TIMEOUT_MS = 15 * 60 * 1000;

let queue: Queue | null = null;

// Parse REDIS_URL into bullmq connection options so bullmq builds its own
// ioredis client (avoids a version clash between our ioredis and bullmq's).
function connectionOptions(): ConnectionOptions | null {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || "6379"),
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    tls: u.protocol === "rediss:" ? {} : undefined,
    maxRetriesPerRequest: null,
  };
}

export function getProberQueue(): Queue | null {
  const connection = connectionOptions();
  if (!connection) return null;
  if (!queue) queue = new Queue(PROBER_QUEUE, { connection });
  return queue;
}

function severityFor(port: number): "low" | "medium" | "high" {
  if (HIGH_RISK_PORTS.has(port)) return "high";
  if (LOW_RISK_PORTS.has(port)) return "low";
  return "medium";
}

interface ScanRow {
  id: string;
  project_id: string;
  host: string;
  status: string;
  created_at: string;
}

async function persistResult(
  supabase: SupabaseClient,
  scan: ScanRow,
  result: PortScanResult,
): Promise<void> {
  const openPorts = result.openPorts.map((p) => p.port);

  await supabase
    .from("port_scans")
    .update({
      status: "done",
      open_ports: openPorts,
      completed_at: new Date().toISOString(),
    })
    .eq("id", scan.id);

  if (result.openPorts.length > 0) {
    // Insert new findings; existing (project_id, port) rows keep their state
    // (e.g. an accepted baseline entry) thanks to ignoreDuplicates.
    const rows = result.openPorts.map((p) => ({
      project_id: scan.project_id,
      scan_id: scan.id,
      port: p.port,
      service: p.service ?? null,
      severity: severityFor(p.port),
      state: "open" as const,
    }));
    await supabase
      .from("port_findings")
      .upsert(rows, { onConflict: "project_id,port", ignoreDuplicates: true });
  }
}

async function markFailed(
  supabase: SupabaseClient,
  scanId: string,
  reason: string,
): Promise<void> {
  await supabase
    .from("port_scans")
    .update({ status: "failed", error: reason, completed_at: new Date().toISOString() })
    .eq("id", scanId);
}

// Enqueue newly-queued scans and reconcile ones already running. Safe to call
// on a short interval; no-ops cleanly when REDIS_URL isn't configured.
export async function processDuePortScans(
  supabase: SupabaseClient,
): Promise<{ enqueued: number; completed: number; failed: number }> {
  const q = getProberQueue();
  if (!q) return { enqueued: 0, completed: 0, failed: 0 };

  let enqueued = 0;
  let completed = 0;
  let failed = 0;

  // 1) queued -> enqueue BullMQ job -> running
  const { data: queuedRows } = await supabase
    .from("port_scans")
    .select("id, project_id, host, status, created_at")
    .eq("status", "queued")
    .limit(20);

  for (const scan of (queuedRows ?? []) as ScanRow[]) {
    try {
      // jobId = scan.id makes enqueue idempotent across retries.
      await q.add(
        "scan",
        { host: scan.host, monitorId: scan.id },
        {
          jobId: scan.id,
          removeOnComplete: { age: 3600 },
          removeOnFail: { age: 86400 },
        },
      );
      await supabase.from("port_scans").update({ status: "running" }).eq("id", scan.id);
      enqueued++;
    } catch (e) {
      await markFailed(supabase, scan.id, `enqueue failed: ${(e as Error).message}`);
      failed++;
    }
  }

  // 2) running -> read finished job return value -> done / failed
  const { data: runningRows } = await supabase
    .from("port_scans")
    .select("id, project_id, host, status, created_at")
    .eq("status", "running")
    .limit(50);

  for (const scan of (runningRows ?? []) as ScanRow[]) {
    const job = (await q.getJob(scan.id)) as Job | undefined;

    if (!job) {
      // No job and an old row => the job was lost (not just slow to enqueue).
      if (Date.now() - new Date(scan.created_at).getTime() > RUNNING_TIMEOUT_MS) {
        await markFailed(supabase, scan.id, "prober job missing");
        failed++;
      }
      continue;
    }

    const state = await job.getState();
    if (state === "completed") {
      await persistResult(supabase, scan, job.returnvalue as PortScanResult);
      completed++;
    } else if (state === "failed") {
      await markFailed(supabase, scan.id, job.failedReason ?? "prober job failed");
      failed++;
    } else if (Date.now() - job.timestamp > RUNNING_TIMEOUT_MS) {
      // Measure the timeout from when the job was ENQUEUED (job.timestamp), not
      // when the scan row was created — a row can sit `queued` a long time
      // before a job exists, and timing out from created_at kills fresh jobs.
      await markFailed(supabase, scan.id, "scan timed out");
      failed++;
    }
  }

  return { enqueued, completed, failed };
}
