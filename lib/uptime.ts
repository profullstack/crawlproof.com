// Uptime monitoring engine (uptime-monitoring-prd.md §3–§7). Runs due checks
// (HTTP / keyword / SSL / TCP), advances the up/down state machine with
// multi-failure confirmation, opens/closes incidents, and sends down/recovery
// email alerts. Called from worker/index.ts on a short interval.
import net from "node:net";
import tls from "node:tls";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Resend } from "resend";

export interface MonitorRow {
  id: string;
  project_id: string;
  name: string;
  type: "http" | "keyword" | "ssl" | "tcp";
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
}

interface CheckResult {
  ok: boolean;
  responseMs: number | null;
  statusCode: number | null;
  error: string | null;
}

const FROM = process.env.RESEND_FROM ?? "CrawlProof <reports@crawlproof.com>";

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

function runCheck(m: MonitorRow): Promise<CheckResult> {
  switch (m.type) {
    case "http":
    case "keyword":
      return checkHttp(m);
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
): Promise<void> {
  if (!m.alert_email) return;
  const down = kind === "down";
  const subject = `${down ? "🔴 DOWN" : "🟢 RECOVERED"}: ${m.name}`;
  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:520px">
      <h2 style="margin:0 0 8px">${down ? "Monitor is DOWN" : "Monitor recovered"}</h2>
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

  await supabase
    .from("monitors")
    .update({
      current_state: state,
      consecutive_failures: failures,
      consecutive_successes: successes,
      last_checked_at: new Date().toISOString(),
      last_error: result.error,
      last_response_ms: result.responseMs,
    })
    .eq("id", m.id);

  if (transition === "down") {
    await supabase.from("monitor_incidents").insert({
      monitor_id: m.id,
      project_id: m.project_id,
      cause: result.error ?? "check failed",
    });
    if (resend) await sendAlert(resend, m, "down", result.error ?? "Check failed.");
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
    } else if (resend) {
      await sendAlert(resend, m, "up", "Back up.");
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
      "id, project_id, name, type, target, config, interval_s, timeout_s, fail_threshold, recover_threshold, current_state, consecutive_failures, consecutive_successes, alert_email",
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
