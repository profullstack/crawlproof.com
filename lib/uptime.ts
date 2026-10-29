// Uptime monitoring engine (uptime-monitoring-prd.md §3–§7). Runs due checks
// (HTTP / SSH login / keyword / SSL / TCP), advances the up/down state machine with
// multi-failure confirmation, opens/closes incidents, and sends down/recovery
// email alerts (plus a phone call via smshub when alert_phone is set). Called
// from worker/index.ts on a short interval.
import net from "node:net";
import tls from "node:tls";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Resend } from "resend";
import { probeSshAuth } from "./ssh-auth-probe";
import { resolveSshKey } from "./uptime-keyring";

export interface MonitorRow {
  id: string;
  project_id: string;
  name: string;
  type: "http" | "ssh" | "keyword" | "ssl" | "tcp";
  target: string;
  config: Record<string, unknown>;
  interval_s: number;
  timeout_s: number;
  fail_threshold: number;
  recover_threshold: number;
  current_state: "up" | "down" | "unknown";
  consecutive_failures: number;
  consecutive_successes: number;
  alert_email: string | null;
  alert_phone: string | null;
  last_down_alert_at: string | null;
}

interface CheckResult {
  ok: boolean;
  responseMs: number | null;
  statusCode: number | null;
  error: string | null;
}

const FROM = process.env.RESEND_FROM ?? "CrawlProof <reports@crawlproof.com>";

// While a monitor stays down, resend the DOWN email on this cadence so a single
// missed alert doesn't leave an outage unnoticed. Override with UPTIME_REALERT_HOURS
// (0 or negative disables reminders and keeps the one-shot behavior).
const REALERT_HOURS = Number(process.env.UPTIME_REALERT_HOURS ?? 6);
const REALERT_MS = REALERT_HOURS > 0 ? REALERT_HOURS * 3_600_000 : 0;

async function checkHttp(m: MonitorRow): Promise<CheckResult> {
  const timeout = m.timeout_s * 1000;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  const started = Date.now();
  try {
    const res = await fetch(m.target, {
      method: "GET",
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "user-agent": "CrawlProof-Uptime/1.0" },
    });
    const responseMs = Date.now() - started;
    const expect = Number(m.config.expected_status ?? 0);
    const ok = expect ? res.status === expect : res.status >= 200 && res.status < 400;

    if (m.type === "keyword") {
      const body = await res.text();
      const keyword = String(m.config.keyword ?? "");
      const mode = m.config.match === "absent" ? "absent" : "present";
      const present = keyword.length > 0 && body.includes(keyword);
      const kwOk = mode === "present" ? present : !present;
      return {
        ok: ok && kwOk,
        responseMs,
        statusCode: res.status,
        error: kwOk ? null : `keyword "${keyword}" ${mode === "present" ? "missing" : "present"}`,
      };
    }
    return {
      ok,
      responseMs,
      statusCode: res.status,
      error: ok ? null : `unexpected status ${res.status}`,
    };
  } catch (e) {
    return { ok: false, responseMs: null, statusCode: null, error: (e as Error).message };
  } finally {
    clearTimeout(t);
  }
}

function parseHostPort(target: string, defaultPort: number): { host: string; port: number } {
  let s = target.trim();
  try {
    if (s.includes("://")) {
      const u = new URL(s);
      return { host: u.hostname, port: u.port ? Number(u.port) : defaultPort };
    }
  } catch {
    /* fall through to host:port parsing */
  }
  const [host, port] = s.split(":");
  return { host, port: port ? Number(port) : defaultPort };
}

function checkTcp(m: MonitorRow): Promise<CheckResult> {
  const { host, port } = parseHostPort(m.target, Number(m.config.port ?? 0) || 80);
  const started = Date.now();
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: m.timeout_s * 1000 });
    const done = (ok: boolean, error: string | null) => {
      socket.destroy();
      resolve({ ok, responseMs: ok ? Date.now() - started : null, statusCode: null, error });
    };
    socket.once("connect", () => done(true, null));
    socket.once("timeout", () => done(false, "connection timed out"));
    socket.once("error", (e) => done(false, e.message));
  });
}

function checkSsl(m: MonitorRow): Promise<CheckResult> {
  const { host, port } = parseHostPort(m.target, 443);
  const warnDays = Number(m.config.warn_days ?? 14);
  const started = Date.now();
  return new Promise((resolve) => {
    const socket = tls.connect(
      { host, port, servername: host, timeout: m.timeout_s * 1000 },
      () => {
        const cert = socket.getPeerCertificate();
        const responseMs = Date.now() - started;
        if (!cert || !cert.valid_to) {
          socket.destroy();
          return resolve({ ok: false, responseMs, statusCode: null, error: "no certificate" });
        }
        const days = Math.floor((new Date(cert.valid_to).getTime() - Date.now()) / 86_400_000);
        socket.destroy();
        resolve({
          ok: days > warnDays,
          responseMs,
          statusCode: null,
          error: days > warnDays ? null : `cert expires in ${days}d (warn ${warnDays}d)`,
        });
      },
    );
    socket.once("timeout", () => {
      socket.destroy();
      resolve({ ok: false, responseMs: null, statusCode: null, error: "tls connection timed out" });
    });
    socket.once("error", (e) => {
      socket.destroy();
      resolve({ ok: false, responseMs: null, statusCode: null, error: e.message });
    });
  });
}

// Up when the server would accept config.public_key for config.username. The
// probe stops at the server's PK_OK, so it never logs in and needs no private
// key (see lib/ssh-auth-probe.ts).
export async function checkSsh(m: MonitorRow): Promise<CheckResult> {
  const { host, port } = parseHostPort(m.target, Number(m.config.port ?? 0) || 22);
  const username = String(m.config.username ?? "");
  // Fleet monitors name a key in the user's logicsrc keyring by fingerprint:
  // use the keyring's current key, DOWN once it is removed, the snapshot if the
  // keyring cannot be fetched (lib/uptime-keyring.ts).
  const key = await resolveSshKey(m.config);
  if ("removed" in key) {
    return { ok: false, responseMs: null, statusCode: null, error: `key ${key.removed} removed from keyring` };
  }
  const r = await probeSshAuth({
    host,
    port,
    username,
    publicKey: key.publicKey,
    timeoutMs: m.timeout_s * 1000,
  });
  if (!r.reachable) return { ok: false, responseMs: null, statusCode: null, error: r.error };
  return {
    ok: r.accepted,
    responseMs: r.responseMs,
    statusCode: null,
    error: r.accepted ? null : `key rejected for ${username}@${host}`,
  };
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}

function runCheck(m: MonitorRow): Promise<CheckResult> {
  switch (m.type) {
    case "http":
    case "keyword":
      return checkHttp(m);
    case "ssh":
      return checkSsh(m);
    case "tcp":
      return checkTcp(m);
    case "ssl":
      return checkSsl(m);
  }
}

async function sendAlert(
  resend: Resend,
  m: MonitorRow,
  kind: "down" | "up",
  detail: string,
  reminder = false,
): Promise<void> {
  if (!m.alert_email) return;
  const down = kind === "down";
  const subject = `${down ? (reminder ? "🔴 STILL DOWN" : "🔴 DOWN") : "🟢 RECOVERED"}: ${m.name}`;
  const heading = down ? (reminder ? "Monitor is STILL DOWN" : "Monitor is DOWN") : "Monitor recovered";
  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:520px">
      <h2 style="margin:0 0 8px">${heading}</h2>
      <p style="margin:0 0 4px"><strong>${m.name}</strong> (${m.type})</p>
      <p style="margin:0 0 4px;color:#555"><code>${m.target}</code></p>
      <p style="margin:8px 0;color:${down ? "#b91c1c" : "#15803d"}">${detail}</p>
      <p style="margin:12px 0 0;color:#888;font-size:12px">${new Date().toISOString()} · CrawlProof Uptime</p>
    </div>`;
  try {
    await resend.emails.send({ from: FROM, to: m.alert_email, subject, html });
  } catch (e) {
    console.warn("[uptime] alert send failed", (e as Error).message);
  }
}

// Phone alerts go through smshub's alerts API with the operator's key. Severity
// "critical" always places a call (smshub reads the message twice and hangs up);
// smshub dedupes the same text to the same phone within 10 minutes.
const SMSHUB_URL = (process.env.SMSHUB_URL ?? "https://smshub.dev").replace(/\/$/, "");

export function phoneAlertText(m: Pick<MonitorRow, "name">, kind: "down" | "up", detail: string): string {
  return kind === "down"
    ? `CrawlProof uptime: ${m.name} is DOWN. ${detail}`.trim()
    : `CrawlProof uptime: ${m.name} is back UP. ${detail}`.trim();
}

export async function callAlert(
  m: Pick<MonitorRow, "name" | "alert_phone">,
  kind: "down" | "up",
  detail: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const key = process.env.SMSHUB_ALERT_API_KEY;
  if (!m.alert_phone || !key) return;
  try {
    const res = await fetchImpl(`${SMSHUB_URL}/api/v1/alerts`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ to: m.alert_phone, message: phoneAlertText(m, kind, detail), severity: "critical" }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) console.warn("[uptime] phone alert failed", res.status, (await res.text()).slice(0, 200));
  } catch (e) {
    console.warn("[uptime] phone alert failed", (e as Error).message);
  }
}

async function processOne(
  supabase: SupabaseClient,
  resend: Resend | null,
  m: MonitorRow,
): Promise<"up" | "down" | "same"> {
  const result = await runCheck(m);

  await supabase.from("monitor_checks").insert({
    monitor_id: m.id,
    ok: result.ok,
    response_ms: result.responseMs,
    status_code: result.statusCode,
    error: result.error,
  });

  let failures = m.consecutive_failures;
  let successes = m.consecutive_successes;
  let state = m.current_state;
  let transition: "up" | "down" | "same" = "same";

  if (result.ok) {
    successes += 1;
    failures = 0;
    if (state !== "up" && successes >= m.recover_threshold) {
      const wasDown = state === "down";
      state = "up";
      if (wasDown) transition = "up";
    }
  } else {
    failures += 1;
    successes = 0;
    if (state !== "down" && failures >= m.fail_threshold) {
      state = "down";
      transition = "down";
    }
  }

  // Reminder: still down, and it's been >= REALERT_MS since the last down alert
  // (initial or reminder). Keeps missed outages from going unnoticed.
  const stillDown = transition === "same" && state === "down";
  const reminderDue =
    stillDown &&
    REALERT_MS > 0 &&
    !!resend &&
    !!m.alert_email &&
    (!m.last_down_alert_at || Date.now() - new Date(m.last_down_alert_at).getTime() >= REALERT_MS);

  // Persist the down-alert timestamp: stamp now whenever we (re)send a down
  // alert, clear it on recovery, otherwise leave it untouched.
  let downAlertAt: string | null | undefined;
  if (transition === "down" || reminderDue) downAlertAt = new Date().toISOString();
  else if (transition === "up") downAlertAt = null;

  await supabase
    .from("monitors")
    .update({
      current_state: state,
      consecutive_failures: failures,
      consecutive_successes: successes,
      last_checked_at: new Date().toISOString(),
      last_error: result.error,
      last_response_ms: result.responseMs,
      ...(downAlertAt !== undefined ? { last_down_alert_at: downAlertAt } : {}),
    })
    .eq("id", m.id);

  if (transition === "down") {
    await supabase.from("monitor_incidents").insert({
      monitor_id: m.id,
      project_id: m.project_id,
      cause: result.error ?? "check failed",
    });
    if (resend) await sendAlert(resend, m, "down", result.error ?? "Check failed.");
    await callAlert(m, "down", result.error ?? "Check failed.");
  } else if (reminderDue && resend) {
    // Report how long it's been down using the open incident's start time.
    const { data: open } = await supabase
      .from("monitor_incidents")
      .select("started_at")
      .eq("monitor_id", m.id)
      .is("ended_at", null)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const downForS = open
      ? Math.round((Date.now() - new Date(open.started_at).getTime()) / 1000)
      : null;
    const forPart = downForS != null ? ` Down for ${formatDuration(downForS)}.` : "";
    await sendAlert(
      resend,
      m,
      "down",
      `${result.error ?? "Still failing."}${forPart} Next reminder in ${REALERT_HOURS}h if not recovered.`,
      true,
    );
  } else if (transition === "up") {
    // Close the open incident and stamp its duration.
    const { data: open } = await supabase
      .from("monitor_incidents")
      .select("id, started_at")
      .eq("monitor_id", m.id)
      .is("ended_at", null)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (open) {
      const durationS = Math.round((Date.now() - new Date(open.started_at).getTime()) / 1000);
      await supabase
        .from("monitor_incidents")
        .update({ ended_at: new Date().toISOString(), duration_s: durationS })
        .eq("id", open.id);
      if (resend) {
        await sendAlert(resend, m, "up", `Back up after ${durationS}s of downtime.`);
      }
      await callAlert(m, "up", `It was down for ${formatDuration(durationS)}.`);
    } else {
      if (resend) await sendAlert(resend, m, "up", "Back up.");
      await callAlert(m, "up", "");
    }
  }

  return transition;
}

// Claim + check all due monitors. Safe on a short interval; claims each row by
// pushing due_at forward before checking so overlapping sweeps don't double-run.
export async function processDueMonitors(
  supabase: SupabaseClient,
  resend: Resend | null,
): Promise<{ checked: number; down: number; up: number }> {
  const { data: due } = await supabase
    .from("monitors")
    .select(
      "id, project_id, name, type, target, config, interval_s, timeout_s, fail_threshold, recover_threshold, current_state, consecutive_failures, consecutive_successes, alert_email, alert_phone, last_down_alert_at",
    )
    .eq("enabled", true)
    .lte("due_at", new Date().toISOString())
    .limit(50);

  const monitors = (due ?? []) as MonitorRow[];
  if (monitors.length === 0) return { checked: 0, down: 0, up: 0 };

  // Claim: push due_at forward immediately.
  await Promise.all(
    monitors.map((m) =>
      supabase
        .from("monitors")
        .update({ due_at: new Date(Date.now() + m.interval_s * 1000).toISOString() })
        .eq("id", m.id),
    ),
  );

  const results = await Promise.allSettled(monitors.map((m) => processOne(supabase, resend, m)));
  let down = 0;
  let up = 0;
  for (const r of results) {
    if (r.status === "fulfilled") {
      if (r.value === "down") down++;
      else if (r.value === "up") up++;
    }
  }
  return { checked: monitors.length, down, up };
}
