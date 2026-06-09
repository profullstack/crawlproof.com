// Safe process runner for the Posture engine's CLI tools (dig, delv, openssl).
//
// SECURITY: the user-supplied domain reaches a subprocess here, so this module
// is the one place command-injection could enter. Two defenses:
//   1. execFile (never a shell) — args are passed as an array, so no value is
//      ever parsed by /bin/sh. Metacharacters are inert.
//   2. Every dynamic argument is validated against a strict allow-list pattern
//      (validHost / validDaneLabel) before it is used.
// Callers must run domains through domainFromTarget (lib/audit/dns) first.

import { execFile } from "node:child_process";

export type RunResult = { ok: true; stdout: string } | { ok: false; error: string };

const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_BUFFER = 4 * 1024 * 1024; // 4 MB — cert chains / dig output stay well under this.

// RFC 1123 hostname (same shape as lib/audit/dns). Used to gate every hostname
// before it becomes a process argument.
const HOST_RE =
  /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i;

// DANE / SRV query names: one or more leading underscore-labels (e.g.
// "_25._tcp", "_443._tcp") followed by a normal hostname.
const DANE_RE =
  /^(_[a-z0-9-]{1,63}\.){1,4}(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i;

export function validHost(h: string): boolean {
  return typeof h === "string" && HOST_RE.test(h);
}

export function validDaneLabel(h: string): boolean {
  return typeof h === "string" && DANE_RE.test(h);
}

/**
 * Run a binary with execFile (no shell). Resolves to the trimmed stdout, or an
 * error string — non-zero exit is NOT thrown (dig/openssl use exit codes for
 * "no record" / "handshake failed" which are normal results, not crashes).
 */
export function run(
  bin: "dig" | "delv" | "openssl",
  args: string[],
  opts: { timeoutMs?: number; input?: string } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(
      bin,
      args,
      {
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
          resolve({ ok: false, error: `${bin} not installed` });
          return;
        }
        // Killed by timeout.
        if (err && (err as { killed?: boolean }).killed) {
          resolve({ ok: false, error: `${bin} timed out` });
          return;
        }
        // Otherwise return whatever stdout we got; a non-zero exit with no
        // stdout falls back to stderr for diagnostics.
        const out = (stdout || "").trim();
        if (out) resolve({ ok: true, stdout: out });
        else if (err) resolve({ ok: false, error: (stderr || err.message || "failed").trim() });
        else resolve({ ok: true, stdout: "" });
      },
    );
    if (opts.input !== undefined && child.stdin) {
      child.stdin.end(opts.input);
    }
  });
}
