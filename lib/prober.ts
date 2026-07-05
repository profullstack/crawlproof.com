// Shared contract between the Railway producer/result-handler and the DO-droplet
// prober (uptime-monitoring-prd.md §12). Keeping the job/result shapes here means
// producer and prober can't drift.

/** BullMQ queue name for port-drift scan jobs. */
export const PROBER_QUEUE = "prober";

/** A port-scan job. `host` MUST be an owner-verified host (gated by the producer). */
export interface PortScanJob {
  /** Hostname or IP to scan (owner-verified upstream). */
  host: string;
  /** Optional: the monitor/project this scan belongs to, for result routing. */
  monitorId?: string;
  orgId?: string;
}

export interface OpenPort {
  port: number;
  proto: string;
  service?: string;
}

/** Result returned as the BullMQ job's return value (the droplet writes no DB). */
export interface PortScanResult {
  host: string;
  scannedAt: string; // ISO
  /** Open ports found by `nmap -sT -Pn --top-ports 100`. */
  openPorts: OpenPort[];
  monitorId?: string;
  orgId?: string;
}
