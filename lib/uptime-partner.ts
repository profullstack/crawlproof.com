// Partner uptime API (/api/uptime/v1): first-party apps (w3bs.org,
// threatcrush.com, via @profullstack/fleetbar) manage a crawlproof user's
// monitors server to server.
//
// Auth on every call: `Authorization: Bearer cpu_…` (a partner token from
// public.uptime_partners, sha256 stored, minted by scripts/mint-uptime-partner.ts)
// plus `X-Fleet-User-Email`, which the partner asserts is its signed-in user's
// VERIFIED email. That maps to the crawlproof user with the same confirmed
// email. `X-Fleet-User-CoinPay-Sub`, when sent, wins: it maps to the user
// linked to that CoinPay account (public.coinpay_identities, bound by sub); everything is scoped to that user's one "Fleet" project
// (projects.kind = 'fleet', made on first use), so the partners and the
// crawlproof dashboard all see the same monitors.
//
// The logic is written against a small UptimeStore so tests run in memory;
// supabaseUptimeStore() is the real one.
import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildMonitorFields, isMonitorType, type MonitorType } from "./uptime-monitor-input";
import { fetchKeyring, isKeysUrl, type KeyringKey } from "./uptime-keyring";

export const PARTNER_TOKEN_RE = /^cpu_[A-Za-z0-9_-]{43}$/;
export const SIGNUP_URL = "https://crawlproof.com/signup";
export const FLEET_PROJECT_NAME = "Fleet";
export const FLEET_PROJECT_URL = "https://crawlproof.com/fleet";
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const PHONE_RE = /^\+[1-9]\d{6,14}$/;
const MAX_MONITORS = 200;

export function mintPartnerToken(): string {
  return "cpu_" + randomBytes(32).toString("base64url");
}

export function hashPartnerToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// ---------------------------------------------------------------- store

export interface PartnerRow {
  id: string;
  name: string;
  revoked_at: string | null;
}
export interface SettingsRow {
  keys_url: string | null;
  alert_email: string | null;
  alert_phone: string | null;
}
export interface FleetMonitorRow {
  id: string;
  project_id: string;
  name: string;
  type: MonitorType;
  target: string;
  config: Record<string, unknown>;
  enabled: boolean;
  interval_s: number;
  current_state: "up" | "down" | "unknown";
  last_checked_at: string | null;
  last_error: string | null;
  last_response_ms: number | null;
  alert_email: string | null;
  alert_phone: string | null;
}
export interface IncidentRow {
  id: string;
  started_at: string;
  ended_at: string | null;
  cause: string | null;
  duration_s: number | null;
}

export interface UptimeStore {
  partnerByHash(hash: string): Promise<PartnerRow | null>;
  userIdByEmail(email: string): Promise<string | null>;
  /** The crawlproof user bound to this CoinPay sub (public.coinpay_identities). */
  userIdByCoinpaySub(sub: string): Promise<string | null>;
  fleetProjectId(userId: string): Promise<string>;
  getSettings(userId: string): Promise<SettingsRow | null>;
  putSettings(userId: string, s: SettingsRow): Promise<void>;
  listMonitors(projectId: string): Promise<FleetMonitorRow[]>;
  getMonitor(projectId: string, id: string): Promise<FleetMonitorRow | null>;
  insertMonitor(row: Record<string, unknown>): Promise<FleetMonitorRow>;
  updateMonitor(projectId: string, id: string, patch: Record<string, unknown>): Promise<FleetMonitorRow | null>;
  deleteMonitor(projectId: string, id: string): Promise<boolean>;
  listIncidents(monitorId: string): Promise<IncidentRow[]>;
}

const MONITOR_COLS =
  "id, project_id, name, type, target, config, enabled, interval_s, current_state, last_checked_at, last_error, last_response_ms, alert_email, alert_phone";

export function supabaseUptimeStore(sb: SupabaseClient): UptimeStore {
  const must = <T>(r: { data: T; error: { message: string } | null }): T => {
    if (r.error) throw new Error(r.error.message);
    return r.data;
  };
  return {
    async partnerByHash(hash) {
      return must(await sb.from("uptime_partners").select("id, name, revoked_at").eq("token_hash", hash).maybeSingle()) as PartnerRow | null;
    },
    async userIdByEmail(email) {
      return (must(await sb.rpc("uptime_user_id_by_email", { p_email: email })) as string | null) ?? null;
    },
    async userIdByCoinpaySub(sub) {
      return (must(await sb.rpc("uptime_user_id_by_coinpay_sub", { p_sub: sub })) as string | null) ?? null;
    },
    async fleetProjectId(userId) {
      const find = async () =>
        must(await sb.from("projects").select("id").eq("owner_id", userId).eq("kind", "fleet").maybeSingle()) as { id: string } | null;
      const found = await find();
      if (found) return found.id;
      const { getOrCreateDefaultOrg } = await import("./orgs");
      const org = await getOrCreateDefaultOrg({ userId }).catch(() => ({ id: "" }));
      const ins = await sb
        .from("projects")
        .insert({
          owner_id: userId,
          name: FLEET_PROJECT_NAME,
          url: FLEET_PROJECT_URL,
          schedule: "off",
          kind: "fleet",
          ...(org.id ? { organization_id: org.id } : {}),
        })
        .select("id")
        .single();
      if (ins.error) {
        // Lost a race with another first call: the unique index kept one.
        const again = await find();
        if (again) return again.id;
        throw new Error(ins.error.message);
      }
      return (ins.data as { id: string }).id;
    },
    async getSettings(userId) {
      return must(await sb.from("uptime_fleet_settings").select("keys_url, alert_email, alert_phone").eq("user_id", userId).maybeSingle()) as SettingsRow | null;
    },
    async putSettings(userId, s) {
      must(await sb.from("uptime_fleet_settings").upsert({ user_id: userId, ...s, updated_at: new Date().toISOString() }, { onConflict: "user_id" }));
    },
    async listMonitors(projectId) {
      return (must(await sb.from("monitors").select(MONITOR_COLS).eq("project_id", projectId).order("created_at", { ascending: true }).limit(MAX_MONITORS)) ?? []) as FleetMonitorRow[];
    },
    async getMonitor(projectId, id) {
      return must(await sb.from("monitors").select(MONITOR_COLS).eq("project_id", projectId).eq("id", id).maybeSingle()) as FleetMonitorRow | null;
    },
    async insertMonitor(row) {
      return must(await sb.from("monitors").insert(row).select(MONITOR_COLS).single()) as FleetMonitorRow;
    },
    async updateMonitor(projectId, id, patch) {
      return must(await sb.from("monitors").update(patch).eq("project_id", projectId).eq("id", id).select(MONITOR_COLS).maybeSingle()) as FleetMonitorRow | null;
    },
    async deleteMonitor(projectId, id) {
      const rows = must(await sb.from("monitors").delete().eq("project_id", projectId).eq("id", id).select("id")) as { id: string }[] | null;
      return (rows ?? []).length > 0;
    },
    async listIncidents(monitorId) {
      return (must(await sb.from("monitor_incidents").select("id, started_at, ended_at, cause, duration_s").eq("monitor_id", monitorId).order("started_at", { ascending: false }).limit(100)) ?? []) as IncidentRow[];
    },
  };
}

// ---------------------------------------------------------------- helpers

export function apiError(status: number, error: string, message: string, extra: Record<string, unknown> = {}): Response {
  return Response.json({ error, message, ...extra }, { status, headers: { "cache-control": "no-store" } });
}

const ok = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** email: the partner-verified email when one was sent ("" when only a CoinPay sub was). */
export type PartnerCtx = { partner: PartnerRow; userId: string; email: string };

export const COINPAY_SUB_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export async function authenticatePartner(req: Request, store: UptimeStore): Promise<PartnerCtx | Response> {
  const header = req.headers.get("authorization") ?? "";
  if (!/^bearer /i.test(header)) return apiError(401, "unauthorized", "Missing bearer token.");
  const token = header.slice(7).trim();
  if (!PARTNER_TOKEN_RE.test(token)) return apiError(401, "unauthorized", "Malformed partner token.");
  const partner = await store.partnerByHash(hashPartnerToken(token));
  if (!partner) return apiError(401, "unauthorized", "Unknown partner token.");
  if (partner.revoked_at) return apiError(401, "token_revoked", "This partner token was revoked.");
  const email = (req.headers.get("x-fleet-user-email") ?? "").trim().toLowerCase();
  // X-Fleet-User-CoinPay-Sub wins over the email: the partner bound its user to
  // that CoinPay account by sub, and crawlproof maps it through its own
  // CoinPay identities (public.coinpay_identities). Never through an email.
  const subHeader = req.headers.get("x-fleet-user-coinpay-sub");
  if (subHeader !== null) {
    const sub = subHeader.trim();
    if (!COINPAY_SUB_RE.test(sub)) return apiError(400, "invalid_coinpay_sub", "X-Fleet-User-CoinPay-Sub is not a CoinPay account id.");
    const userId = await store.userIdByCoinpaySub(sub);
    if (!userId) {
      return apiError(404, "no_crawlproof_account", "No crawlproof account is connected to this CoinPay account.", { signup_url: SIGNUP_URL });
    }
    return { partner, userId, email: EMAIL_RE.test(email) ? email : "" };
  }
  if (!EMAIL_RE.test(email)) return apiError(400, "missing_user_email", "X-Fleet-User-Email must be the user's verified email.");
  const userId = await store.userIdByEmail(email);
  if (!userId) {
    return apiError(404, "no_crawlproof_account", `No crawlproof account with the confirmed email ${email}.`, { signup_url: SIGNUP_URL });
  }
  return { partner, userId, email };
}

export function serializeMonitor(m: FleetMonitorRow) {
  const out: Record<string, unknown> = {
    id: m.id,
    name: m.name,
    type: m.type,
    target: m.target,
    enabled: m.enabled,
    interval_s: m.interval_s,
    current_state: m.current_state,
    last_checked_at: m.last_checked_at,
    last_error: m.last_error,
    last_response_ms: m.last_response_ms,
    alert_email: m.alert_email,
    alert_phone: m.alert_phone,
  };
  if (m.type === "keyword") {
    out.keyword = m.config.keyword ?? null;
    out.match = m.config.match ?? "present";
  }
  if (m.type === "ssh") {
    out.ssh = {
      username: m.config.username ?? null,
      fingerprint: m.config.fingerprint ?? null,
      key_comment: m.config.key_comment ?? null,
      key_source: typeof m.config.keys_url === "string" && m.config.keys_url ? "keyring" : "inline",
    };
  }
  return out;
}

async function readJson(req: Request): Promise<Record<string, unknown> | Response> {
  try {
    const body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return apiError(400, "invalid_body", "Body must be a JSON object.");
    return body as Record<string, unknown>;
  } catch {
    return apiError(400, "invalid_body", "Body must be JSON.");
  }
}

function optString(body: Record<string, unknown>, key: string): string | null | undefined | Response {
  const v = body[key];
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  if (typeof v !== "string") return apiError(422, "invalid_field", `${key} must be a string.`);
  return v.trim();
}

function checkEmail(v: string | null | undefined, key: string): Response | null {
  if (v && !EMAIL_RE.test(v)) return apiError(422, "invalid_field", `${key} is not an email address.`);
  return null;
}
function checkPhone(v: string | null | undefined, key: string): Response | null {
  if (v && !PHONE_RE.test(v)) return apiError(422, "invalid_field", `${key} must be E.164, e.g. +14155550123.`);
  return null;
}

// ---------------------------------------------------------------- deps

export interface UptimeDeps {
  store: UptimeStore;
  fetchImpl?: typeof fetch;
}

// ---------------------------------------------------------------- settings / keys

async function getSettings(ctx: PartnerCtx, deps: UptimeDeps): Promise<Response> {
  const s = await deps.store.getSettings(ctx.userId);
  return ok({ keys_url: s?.keys_url ?? null, alert_email: s?.alert_email ?? null, alert_phone: s?.alert_phone ?? null });
}

async function putSettings(req: Request, ctx: PartnerCtx, deps: UptimeDeps): Promise<Response> {
  const body = await readJson(req);
  if (body instanceof Response) return body;
  const prev = (await deps.store.getSettings(ctx.userId)) ?? { keys_url: null, alert_email: null, alert_phone: null };
  const next = { ...prev };
  for (const key of ["keys_url", "alert_email", "alert_phone"] as const) {
    const v = optString(body, key);
    if (v instanceof Response) return v;
    if (v !== undefined) next[key] = v;
  }
  if (next.keys_url && !isKeysUrl(next.keys_url)) {
    return apiError(422, "invalid_keys_url", "keys_url must be a logicsrc keyring share link: https://app.logicsrc.com/k/lks_….json");
  }
  const bad = checkEmail(next.alert_email, "alert_email") ?? checkPhone(next.alert_phone, "alert_phone");
  if (bad) return bad;
  await deps.store.putSettings(ctx.userId, next);
  return ok(next);
}

async function getKeys(ctx: PartnerCtx, deps: UptimeDeps): Promise<Response> {
  const s = await deps.store.getSettings(ctx.userId);
  if (!s?.keys_url) return ok({ keys: [], keys_url: null });
  const ring = await fetchKeyring(s.keys_url, { fetchImpl: deps.fetchImpl });
  if (!ring.ok) return apiError(422, "keyring_unavailable", `Could not read the keyring: ${ring.error}`);
  return ok({ keys: ring.keys, keys_url: s.keys_url });
}

// ---------------------------------------------------------------- monitors

type SshResolved = { username: string; publicKey: string; keysUrl: string | null; fingerprint: string | null; comment: string | null };

/** body.ssh → the public key to validate, from the keyring by fingerprint or inline. */
async function resolveSshBody(ssh: unknown, ctx: PartnerCtx, deps: UptimeDeps): Promise<SshResolved | Response> {
  if (!ssh || typeof ssh !== "object") return apiError(422, "invalid_monitor", "ssh: { username, fingerprint } or { username, public_key } is required.");
  const s = ssh as Record<string, unknown>;
  const username = typeof s.username === "string" ? s.username : "";
  if (typeof s.public_key === "string" && s.public_key.trim()) {
    return { username, publicKey: s.public_key, keysUrl: null, fingerprint: null, comment: null };
  }
  if (typeof s.fingerprint !== "string" || !s.fingerprint.trim()) {
    return apiError(422, "invalid_monitor", "ssh needs a fingerprint from the keyring or a public_key.");
  }
  // A private key pasted where a fingerprint goes is still refused, never echoed.
  if (/PRIVATE KEY/.test(s.fingerprint)) return apiError(422, "invalid_monitor", "That is a private key. Paste the public key (the .pub file) instead.");
  const settings = await deps.store.getSettings(ctx.userId);
  if (!settings?.keys_url) return apiError(409, "no_keys_url", "Set keys_url (your logicsrc keyring share link) before adding a check by fingerprint.");
  const ring = await fetchKeyring(settings.keys_url, { fetchImpl: deps.fetchImpl, fresh: true });
  if (!ring.ok) return apiError(422, "keyring_unavailable", `Could not read the keyring: ${ring.error}`);
  const fp = s.fingerprint.trim();
  const key = ring.keys.find((k: KeyringKey) => k.fingerprint === fp);
  if (!key) return apiError(422, "key_not_in_keyring", `Key ${fp} is not in the keyring.`);
  return { username, publicKey: key.public_key, keysUrl: settings.keys_url, fingerprint: key.fingerprint, comment: key.comment || null };
}

/** Build {name,type,target,config,interval_s} with the dashboard's rules. */
async function buildFields(
  merged: { name: string; type: unknown; target: string; interval_s?: unknown; keyword?: unknown; match?: unknown },
  ssh: unknown | undefined,
  keepSshConfig: Record<string, unknown> | null,
  ctx: PartnerCtx,
  deps: UptimeDeps,
): Promise<{ name: string; type: MonitorType; target: string; config: Record<string, unknown>; interval_s: number } | Response> {
  if (!isMonitorType(merged.type)) return apiError(422, "invalid_monitor", "type must be one of ssh, http, keyword, ssl, tcp.");
  if (merged.interval_s !== undefined && (typeof merged.interval_s !== "number" || !Number.isInteger(merged.interval_s) || merged.interval_s < 60 || merged.interval_s > 86_400)) {
    return apiError(422, "invalid_monitor", "interval_s must be a whole number of seconds from 60 to 86400.");
  }
  if (merged.match !== undefined && merged.match !== null && merged.match !== "present" && merged.match !== "absent") {
    return apiError(422, "invalid_monitor", 'match must be "present" or "absent".');
  }
  if (merged.type === "ssh" && keepSshConfig) {
    // SSH key and user unchanged: only the shared name/target/interval rules apply.
    const plain = buildMonitorFields({ name: merged.name, type: "tcp", target: merged.target, intervalS: merged.interval_s as number | undefined });
    if (!plain.ok) return apiError(422, "invalid_monitor", plain.error);
    return { ...plain.fields, type: "ssh", config: keepSshConfig };
  }
  let resolved: SshResolved | null = null;
  if (merged.type === "ssh") {
    const r = await resolveSshBody(ssh, ctx, deps);
    if (r instanceof Response) return r;
    resolved = r;
  }
  const built = buildMonitorFields({
    name: merged.name,
    type: merged.type,
    target: merged.target,
    intervalS: merged.interval_s as number | undefined,
    keyword: typeof merged.keyword === "string" ? merged.keyword : undefined,
    match: (merged.match as "present" | "absent" | undefined) ?? undefined,
    username: resolved?.username,
    publicKey: resolved?.publicKey,
  });
  if (!built.ok) return apiError(422, "invalid_monitor", built.error);
  const fields = built.fields;
  if (resolved?.keysUrl) {
    fields.config = {
      ...fields.config,
      keys_url: resolved.keysUrl,
      fingerprint: resolved.fingerprint,
      ...(resolved.comment ? { key_comment: resolved.comment } : {}),
    };
  }
  return fields;
}

async function listMonitors(ctx: PartnerCtx, deps: UptimeDeps): Promise<Response> {
  const projectId = await deps.store.fleetProjectId(ctx.userId);
  const rows = await deps.store.listMonitors(projectId);
  return ok({ monitors: rows.map(serializeMonitor) });
}

async function createMonitor(req: Request, ctx: PartnerCtx, deps: UptimeDeps): Promise<Response> {
  const body = await readJson(req);
  if (body instanceof Response) return body;
  const alertEmail = optString(body, "alert_email");
  if (alertEmail instanceof Response) return alertEmail;
  const alertPhone = optString(body, "alert_phone");
  if (alertPhone instanceof Response) return alertPhone;
  const bad = checkEmail(alertEmail, "alert_email") ?? checkPhone(alertPhone, "alert_phone");
  if (bad) return bad;
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") return apiError(422, "invalid_monitor", "enabled must be a boolean.");

  const fields = await buildFields(
    {
      name: typeof body.name === "string" ? body.name : "",
      type: body.type,
      target: typeof body.target === "string" ? body.target : "",
      interval_s: body.interval_s,
      keyword: body.keyword,
      match: body.match,
    },
    body.ssh,
    null,
    ctx,
    deps,
  );
  if (fields instanceof Response) return fields;

  const projectId = await deps.store.fleetProjectId(ctx.userId);
  const existing = await deps.store.listMonitors(projectId);
  if (existing.length >= MAX_MONITORS) return apiError(409, "too_many_monitors", `A fleet holds at most ${MAX_MONITORS} checks.`);
  const settings = await deps.store.getSettings(ctx.userId);
  const row = await deps.store.insertMonitor({
    project_id: projectId,
    ...fields,
    enabled: body.enabled ?? true,
    alert_email: alertEmail === undefined ? (settings?.alert_email ?? (ctx.email || null)) : alertEmail,
    alert_phone: alertPhone === undefined ? (settings?.alert_phone ?? null) : alertPhone,
    due_at: new Date().toISOString(),
  });
  return ok({ monitor: serializeMonitor(row) }, 201);
}

async function patchMonitor(req: Request, ctx: PartnerCtx, deps: UptimeDeps, id: string): Promise<Response> {
  const body = await readJson(req);
  if (body instanceof Response) return body;
  const projectId = await deps.store.fleetProjectId(ctx.userId);
  const row = await deps.store.getMonitor(projectId, id);
  if (!row) return apiError(404, "not_found", "No such monitor in this fleet.");

  const patch: Record<string, unknown> = {};
  const alertEmail = optString(body, "alert_email");
  if (alertEmail instanceof Response) return alertEmail;
  const alertPhone = optString(body, "alert_phone");
  if (alertPhone instanceof Response) return alertPhone;
  const bad = checkEmail(alertEmail, "alert_email") ?? checkPhone(alertPhone, "alert_phone");
  if (bad) return bad;
  if (alertEmail !== undefined) patch.alert_email = alertEmail;
  if (alertPhone !== undefined) patch.alert_phone = alertPhone;
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") return apiError(422, "invalid_monitor", "enabled must be a boolean.");
    patch.enabled = body.enabled;
    if (body.enabled && !row.enabled) patch.due_at = new Date().toISOString();
  }

  const touchesCheck = ["name", "type", "target", "interval_s", "keyword", "match", "ssh"].some((k) => body[k] !== undefined);
  if (touchesCheck) {
    const type = body.type ?? row.type;
    const keepSsh = type === "ssh" && row.type === "ssh" && body.ssh === undefined ? row.config : null;
    const fields = await buildFields(
      {
        name: typeof body.name === "string" ? body.name : row.name,
        type,
        target: typeof body.target === "string" ? body.target : row.target,
        interval_s: body.interval_s ?? row.interval_s,
        keyword: body.keyword ?? row.config.keyword,
        match: body.match ?? row.config.match,
      },
      body.ssh,
      keepSsh,
      ctx,
      deps,
    );
    if (fields instanceof Response) return fields;
    // An unchanged ssh/http config survives a rename; carry over HTTP extras the API does not edit.
    const extras: Record<string, unknown> = {};
    for (const k of ["expected_status", "port", "warn_days"]) if (fields.type === row.type && row.config[k] !== undefined) extras[k] = row.config[k];
    Object.assign(patch, fields, { config: { ...extras, ...fields.config } });
    if (fields.target !== row.target || fields.type !== row.type || body.ssh !== undefined) patch.due_at = new Date().toISOString();
  }
  if (Object.keys(patch).length === 0) return ok({ monitor: serializeMonitor(row) });
  const updated = await deps.store.updateMonitor(projectId, id, patch);
  if (!updated) return apiError(404, "not_found", "No such monitor in this fleet.");
  return ok({ monitor: serializeMonitor(updated) });
}

// ---------------------------------------------------------------- router

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Route /api/uptime/v1/<segments> for an authenticated partner call. */
export async function handleUptimeApi(req: Request, segments: string[], deps: UptimeDeps): Promise<Response> {
  try {
    const ctx = await authenticatePartner(req, deps.store);
    if (ctx instanceof Response) return ctx;
    const method = req.method.toUpperCase();
    const [head, id, tail, ...rest] = segments;
    const notAllowed = () => apiError(405, "method_not_allowed", `${method} is not supported here.`);
    if (rest.length) return apiError(404, "not_found", "Unknown endpoint.");

    if (head === "settings" && !id) {
      if (method === "GET") return getSettings(ctx, deps);
      if (method === "PUT") return putSettings(req, ctx, deps);
      return notAllowed();
    }
    if (head === "keys" && !id) {
      if (method === "GET") return getKeys(ctx, deps);
      return notAllowed();
    }
    if (head === "monitors" && !id) {
      if (method === "GET") return listMonitors(ctx, deps);
      if (method === "POST") return createMonitor(req, ctx, deps);
      return notAllowed();
    }
    if (head === "monitors" && id) {
      if (!UUID_RE.test(id)) return apiError(404, "not_found", "No such monitor in this fleet.");
      if (tail === "incidents") {
        if (method !== "GET") return notAllowed();
        const projectId = await deps.store.fleetProjectId(ctx.userId);
        const m = await deps.store.getMonitor(projectId, id);
        if (!m) return apiError(404, "not_found", "No such monitor in this fleet.");
        return ok({ incidents: await deps.store.listIncidents(m.id) });
      }
      if (tail) return apiError(404, "not_found", "Unknown endpoint.");
      if (method === "GET") {
        const projectId = await deps.store.fleetProjectId(ctx.userId);
        const m = await deps.store.getMonitor(projectId, id);
        return m ? ok({ monitor: serializeMonitor(m) }) : apiError(404, "not_found", "No such monitor in this fleet.");
      }
      if (method === "PATCH") return patchMonitor(req, ctx, deps, id);
      if (method === "DELETE") {
        const projectId = await deps.store.fleetProjectId(ctx.userId);
        return (await deps.store.deleteMonitor(projectId, id))
          ? ok({ deleted: true, id })
          : apiError(404, "not_found", "No such monitor in this fleet.");
      }
      return notAllowed();
    }
    return apiError(404, "not_found", "Unknown endpoint.");
  } catch (e) {
    console.error("[uptime-api]", (e as Error).message);
    return apiError(500, "internal_error", "Something went wrong.");
  }
}

