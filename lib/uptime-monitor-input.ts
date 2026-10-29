// Monitor validation shared by the dashboard's createMonitor server action and
// the partner uptime API (/api/uptime/v1). One rule set, so a monitor made from
// w3bs.org or threatcrush.com is held to exactly what the dashboard enforces,
// including refusing private keys for SSH checks.
import { fingerprint, parsePublicKey } from "./ssh-auth-probe";

export const MONITOR_TYPES = ["http", "ssh", "keyword", "ssl", "tcp"] as const;
export type MonitorType = (typeof MONITOR_TYPES)[number];

export interface MonitorFieldsInput {
  name: string;
  type: MonitorType;
  target: string;
  intervalS?: number;
  keyword?: string;
  match?: "present" | "absent";
  expectedStatus?: number;
  port?: number;
  warnDays?: number;
  /** ssh: the account to check, which must exist on the host. */
  username?: string;
  /** ssh: an OpenSSH public key line. Private keys are refused. */
  publicKey?: string;
}

export interface MonitorFields {
  name: string;
  type: MonitorType;
  target: string;
  config: Record<string, unknown>;
  interval_s: number;
}

export const SSH_USERNAME_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,31}$/;

export function isMonitorType(v: unknown): v is MonitorType {
  return typeof v === "string" && (MONITOR_TYPES as readonly string[]).includes(v);
}

export function buildMonitorFields(
  input: MonitorFieldsInput,
): { ok: true; fields: MonitorFields } | { ok: false; error: string } {
  if (!isMonitorType(input.type)) return { ok: false, error: "Unknown monitor type." };
  const name = (input.name ?? "").trim();
  const target = (input.target ?? "").trim();
  if (!name || !target) return { ok: false, error: "Name and target are required." };

  const config: Record<string, unknown> = {};
  if (input.type === "keyword") {
    if (!input.keyword?.trim()) return { ok: false, error: "Keyword is required." };
    config.keyword = input.keyword.trim();
    config.match = input.match ?? "present";
  }
  if (input.type === "ssh") {
    const username = input.username?.trim() ?? "";
    if (!SSH_USERNAME_RE.test(username)) {
      return { ok: false, error: "A valid SSH username is required." };
    }
    const parsed = parsePublicKey(input.publicKey ?? "");
    if ("error" in parsed) return { ok: false, error: parsed.error };
    config.username = username;
    config.public_key = parsed.key.type + " " + parsed.key.getPublicSSH().toString("base64");
    config.fingerprint = fingerprint(parsed.key);
    if (parsed.key.comment) config.key_comment = parsed.key.comment;
  }
  if (input.type === "http" && input.expectedStatus) config.expected_status = input.expectedStatus;
  if (input.type === "tcp" && input.port) config.port = input.port;
  if (input.type === "ssl" && input.warnDays) config.warn_days = input.warnDays;

  return {
    ok: true,
    fields: {
      name,
      type: input.type,
      target,
      config,
      interval_s: input.intervalS && input.intervalS >= 60 ? input.intervalS : 60,
    },
  };
}
