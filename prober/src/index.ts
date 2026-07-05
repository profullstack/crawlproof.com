// CrawlProof port-drift prober (uptime-monitoring-prd.md §12).
//
// A BullMQ Worker running on a self-hosted DigitalOcean droplet. It dials OUT
// to Redis (rediss://) — no inbound port — pulls port-scan jobs off the
// "prober" queue, runs a bounded `nmap -sT -Pn --top-ports 100` TCP-connect
// scan, and returns the open-port set as the job's return value. It writes no
// database; the Railway side handles results (baseline diff + alerts).
import { Worker, type Job, type ConnectionOptions } from "bullmq";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexecFile = promisify(execFile);

// Contract (mirrors lib/prober.ts — kept in sync via review; the droplet build
// is standalone so it doesn't import across the monorepo root).
const PROBER_QUEUE = "prober";
interface PortScanJob {
  host: string;
  monitorId?: string;
  orgId?: string;
}
interface OpenPort {
  port: number;
  proto: string;
  service?: string;
}
interface PortScanResult {
  host: string;
  scannedAt: string;
  openPorts: OpenPort[];
  monitorId?: string;
  orgId?: string;
}

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) {
  console.error("[prober] FATAL: REDIS_URL is not set");
  process.exit(1);
}

// Only scan things that look like a public hostname or IP. Ownership is gated
// by the producer; this is a defensive format check + a block on obvious
// internal targets so a bad job can't scan the droplet's own network.
function assertScannableHost(host: string): void {
  if (typeof host !== "string" || host.length === 0 || host.length > 253) {
    throw new Error("invalid host");
  }
  if (!/^[a-zA-Z0-9.-]+$/.test(host)) throw new Error("invalid host characters");
  const blocked = [
    /^localhost$/i,
    /^127\./,
    /^10\./,
    /^192\.168\./,
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
    /^169\.254\./,
    /^0\./,
  ];
  if (blocked.some((re) => re.test(host))) throw new Error("host is in a blocked (internal) range");
}

async function scan(job: PortScanJob): Promise<PortScanResult> {
  assertScannableHost(job.host);
  // -sT connect scan (no CAP_NET_RAW needed), -Pn skip host discovery,
  // --top-ports 100 bounded set, -oG - greppable output on stdout.
  const { stdout } = await pexecFile(
    "nmap",
    ["-sT", "-Pn", "--top-ports", "100", "-oG", "-", job.host],
    { timeout: 180_000, maxBuffer: 8 * 1024 * 1024 },
  );

  const openPorts: OpenPort[] = [];
  const m = stdout.match(/Ports:\s*(.+)/);
  if (m && m[1]) {
    for (const entry of m[1].split(",")) {
      // format: port/state/proto//service///
      const f = entry.trim().split("/");
      if (f[1] === "open") {
        openPorts.push({ port: Number(f[0]), proto: f[2] || "tcp", service: f[4] || undefined });
      }
    }
  }
  openPorts.sort((a, b) => a.port - b.port);
  return {
    host: job.host,
    scannedAt: new Date().toISOString(),
    openPorts,
    monitorId: job.monitorId,
    orgId: job.orgId,
  };
}

// Build a BullMQ connection from the Redis URL (supports rediss:// TLS). We let
// BullMQ own the ioredis client instead of importing ioredis ourselves.
const redisUrl = new URL(REDIS_URL);
const connection: ConnectionOptions = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port || 6379),
  username: redisUrl.username ? decodeURIComponent(redisUrl.username) : undefined,
  password: redisUrl.password ? decodeURIComponent(redisUrl.password) : undefined,
  ...(redisUrl.protocol === "rediss:" ? { tls: {} } : {}),
  maxRetriesPerRequest: null,
};

const worker = new Worker<PortScanJob, PortScanResult>(
  PROBER_QUEUE,
  async (job: Job<PortScanJob>) => {
    console.log(`[prober] scanning ${job.data.host} (job ${job.id})`);
    const result = await scan(job.data);
    console.log(
      `[prober] ${result.host}: ${result.openPorts.length} open ` +
        `(${result.openPorts.map((p) => p.port).join(",") || "none"})`,
    );
    return result;
  },
  { connection, concurrency: 2 },
);

worker.on("ready", () => console.log(`[prober] worker ready, listening on queue "${PROBER_QUEUE}"`));
worker.on("failed", (job, err) => console.error(`[prober] job ${job?.id} failed: ${err.message}`));
worker.on("error", (err) => console.error(`[prober] worker error: ${err.message}`));

async function shutdown(sig: string) {
  console.log(`[prober] ${sig} — shutting down`);
  await worker.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

console.log("[prober] started");
