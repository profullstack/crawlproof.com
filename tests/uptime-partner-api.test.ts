import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { utils } from "ssh2";
import {
  handleUptimeApi,
  hashPartnerToken,
  mintPartnerToken,
  type FleetMonitorRow,
  type IncidentRow,
  type SettingsRow,
  type UptimeStore,
} from "../lib/uptime-partner";
import { clearKeyringCache, fetchKeyring, isKeysUrl, resolveSshKey } from "../lib/uptime-keyring";
import { buildMonitorFields } from "../lib/uptime-monitor-input";
import { checkSsh, type MonitorRow } from "../lib/uptime";
import { fingerprint, parsePublicKey } from "../lib/ssh-auth-probe";

const BASE = "https://crawlproof.com/api/uptime/v1/";
const KEYS_URL = "https://app.logicsrc.com/k/lks_" + "A".repeat(43) + ".json";

const keyA = utils.generateKeyPairSync("ed25519", { comment: "a@laptop" });
const keyB = utils.generateKeyPairSync("ed25519", { comment: "b@desk" });
const fpOf = (pub: string) => fingerprint((parsePublicKey(pub) as { key: import("ssh2").ParsedKey }).key);
const FP_A = fpOf(keyA.public);
const FP_B = fpOf(keyB.public);

function memoryStore() {
  const partners = new Map<string, { id: string; name: string; revoked_at: string | null }>();
  const users = new Map<string, string>([
    ["alice@example.com", "user-a"],
    ["bob@example.com", "user-b"],
  ]);
  // CoinPay identities: bob's crawlproof account is linked to CoinPay sub-bob.
  const subs = new Map<string, string>([["sub-bob", "user-b"]]);
  const projects = new Map<string, string>();
  const settings = new Map<string, SettingsRow>();
  const monitors: (FleetMonitorRow & Record<string, unknown>)[] = [];
  const incidents = new Map<string, IncidentRow[]>();
  const store: UptimeStore = {
    async partnerByHash(h) {
      return partners.get(h) ?? null;
    },
    async userIdByEmail(e) {
      return users.get(e.toLowerCase()) ?? null;
    },
    async userIdByCoinpaySub(sub) {
      return subs.get(sub) ?? null;
    },
    async fleetProjectId(u) {
      if (!projects.has(u)) projects.set(u, `fleet-${u}`);
      return projects.get(u)!;
    },
    async getSettings(u) {
      return settings.get(u) ?? null;
    },
    async putSettings(u, s) {
      settings.set(u, { ...s });
    },
    async listMonitors(p) {
      return monitors.filter((m) => m.project_id === p);
    },
    async getMonitor(p, id) {
      return monitors.find((m) => m.project_id === p && m.id === id) ?? null;
    },
    async insertMonitor(row) {
      const m = {
        id: randomUUID(),
        enabled: true,
        current_state: "unknown",
        last_checked_at: null,
        last_error: null,
        last_response_ms: null,
        alert_email: null,
        alert_phone: null,
        ...row,
      } as FleetMonitorRow & Record<string, unknown>;
      monitors.push(m);
      return m;
    },
    async updateMonitor(p, id, patch) {
      const m = monitors.find((x) => x.project_id === p && x.id === id);
      if (!m) return null;
      Object.assign(m, patch);
      return m;
    },
    async deleteMonitor(p, id) {
      const i = monitors.findIndex((x) => x.project_id === p && x.id === id);
      if (i < 0) return false;
      monitors.splice(i, 1);
      return true;
    },
    async listIncidents(id) {
      return incidents.get(id) ?? [];
    },
  };
  const addPartner = (name: string, revoked = false) => {
    const token = mintPartnerToken();
    partners.set(hashPartnerToken(token), { id: name, name, revoked_at: revoked ? new Date().toISOString() : null });
    return token;
  };
  return { store, monitors, settings, addPartner };
}

let ringKeys: { name: string; type: string; public_key: string; fingerprint: string; comment: string }[] = [];
let ringStatus = 200;
const fakeFetch = (async (url: string) => {
  expect(String(url)).toBe(KEYS_URL);
  return new Response(JSON.stringify({ keys: ringKeys }), { status: ringStatus, headers: { "content-type": "application/json" } });
}) as unknown as typeof fetch;

let db: ReturnType<typeof memoryStore>;
let token: string;

function call(method: string, path: string, opts: { body?: unknown; email?: string | null; tok?: string | null; sub?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const t = opts.tok === undefined ? token : opts.tok;
  if (t) headers.authorization = `Bearer ${t}`;
  const email = opts.email === undefined ? "Alice@Example.com" : opts.email;
  if (email) headers["x-fleet-user-email"] = email;
  if (opts.sub !== undefined) headers["x-fleet-user-coinpay-sub"] = opts.sub;
  const req = new Request(BASE + path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  return handleUptimeApi(req, path.split("/").filter(Boolean), { store: db.store, fetchImpl: fakeFetch });
}

beforeEach(() => {
  clearKeyringCache();
  db = memoryStore();
  token = db.addPartner("w3bs");
  ringStatus = 200;
  ringKeys = [
    { name: "laptop", type: "ssh-ed25519", public_key: keyA.public, fingerprint: FP_A, comment: "a@laptop" },
    { name: "desk", type: "ssh-ed25519", public_key: keyB.public, fingerprint: FP_B, comment: "b@desk" },
  ];
});

describe("partner auth", () => {
  it("refuses a missing, malformed or unknown token with 401", async () => {
    expect((await call("GET", "monitors", { tok: null })).status).toBe(401);
    expect((await call("GET", "monitors", { tok: "cpu_short" })).status).toBe(401);
    const r = await call("GET", "monitors", { tok: mintPartnerToken() });
    expect(r.status).toBe(401);
    expect(await r.json()).toMatchObject({ error: "unauthorized" });
  });

  it("refuses a revoked token", async () => {
    const revoked = db.addPartner("old", true);
    const r = await call("GET", "monitors", { tok: revoked });
    expect(r.status).toBe(401);
    expect(await r.json()).toMatchObject({ error: "token_revoked" });
  });

  it("needs the user's email header", async () => {
    expect((await call("GET", "monitors", { email: null })).status).toBe(400);
  });

  it("answers no_crawlproof_account with a signup link for an unknown email", async () => {
    const r = await call("GET", "monitors", { email: "nobody@example.com" });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({
      error: "no_crawlproof_account",
      message: expect.any(String),
      signup_url: "https://crawlproof.com/signup",
    });
  });
});

describe("X-Fleet-User-CoinPay-Sub", () => {
  it("wins over the email: alice's email + bob's sub is bob's fleet", async () => {
    await call("POST", "monitors", { body: { name: "alice-site", type: "http", target: "https://a.io" } });
    const r = await call("GET", "monitors", { sub: "sub-bob" });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).monitors).toEqual([]);
    const c = await call("POST", "monitors", { sub: "sub-bob", email: null, body: { name: "bob-site", type: "http", target: "https://b.io" } });
    expect(c.status).toBe(201);
    expect(db.monitors.find((m) => m.name === "bob-site")!.project_id).toBe("fleet-user-b");
  });

  it("works without any email; no default alert email is invented", async () => {
    const c = await call("POST", "monitors", { sub: "sub-bob", email: null, body: { name: "b", type: "http", target: "https://b.io" } });
    expect(c.status).toBe(201);
    expect(((await c.json()) as any).monitor.alert_email).toBeNull();
  });

  it("an unlinked sub is no_crawlproof_account even when the email has an account", async () => {
    const r = await call("GET", "monitors", { sub: "sub-nobody" });
    expect(r.status).toBe(404);
    expect(await r.json()).toMatchObject({ error: "no_crawlproof_account", signup_url: "https://crawlproof.com/signup" });
  });

  it("refuses a malformed sub", async () => {
    expect((await call("GET", "monitors", { sub: "a b" })).status).toBe(400);
    expect((await call("GET", "monitors", { sub: "" })).status).toBe(400);
  });
});

describe("settings and keys", () => {
  it("stores a keyring share link and alert defaults, refusing other URLs", async () => {
    const bad = await call("PUT", "settings", { body: { keys_url: "https://evil.example/k/lks_x.json" } });
    expect(bad.status).toBe(422);
    expect((await call("PUT", "settings", { body: { alert_phone: "555" } })).status).toBe(422);
    const r = await call("PUT", "settings", { body: { keys_url: KEYS_URL, alert_email: "ops@example.com", alert_phone: "+14155550123" } });
    expect(r.status).toBe(200);
    expect(await (await call("GET", "settings")).json()).toEqual({ keys_url: KEYS_URL, alert_email: "ops@example.com", alert_phone: "+14155550123" });
  });

  it("lists the keyring keys server-side", async () => {
    await call("PUT", "settings", { body: { keys_url: KEYS_URL } });
    const body = (await (await call("GET", "keys")).json()) as { keys: { fingerprint: string }[] };
    expect(body.keys.map((k) => k.fingerprint)).toEqual([FP_A, FP_B]);
  });

  it("only accepts app.logicsrc.com share links", () => {
    expect(isKeysUrl(KEYS_URL)).toBe(true);
    expect(isKeysUrl(KEYS_URL.replace("https:", "http:"))).toBe(false);
    expect(isKeysUrl(KEYS_URL.replace("app.logicsrc.com", "app.logicsrc.com.evil.io"))).toBe(false);
    expect(isKeysUrl("https://app.logicsrc.com/k/lks_" + "A".repeat(43) + ".keys")).toBe(false);
  });
});

describe("monitors", () => {
  it("creates an SSH check from the keyring by fingerprint and lists it", async () => {
    await call("PUT", "settings", { body: { keys_url: KEYS_URL, alert_phone: "+14155550123" } });
    const r = await call("POST", "monitors", {
      body: { name: "root@web1", type: "ssh", target: "web1.example.com:2222", ssh: { username: "root", fingerprint: FP_A } },
    });
    expect(r.status).toBe(201);
    const { monitor } = (await r.json()) as { monitor: Record<string, any> };
    expect(monitor.ssh).toEqual({ username: "root", fingerprint: FP_A, key_comment: "a@laptop", key_source: "keyring" });
    expect(monitor.alert_email).toBe("alice@example.com");
    expect(monitor.alert_phone).toBe("+14155550123");
    const stored = db.monitors[0];
    expect(stored.config).toMatchObject({ username: "root", fingerprint: FP_A, keys_url: KEYS_URL });
    expect(String(stored.config.public_key)).toMatch(/^ssh-ed25519 /);
    const list = (await (await call("GET", "monitors")).json()) as { monitors: { id: string }[] };
    expect(list.monitors.map((m) => m.id)).toEqual([monitor.id]);
  });

  it("refuses a fingerprint not in the keyring, and one with no keys_url set", async () => {
    const noUrl = await call("POST", "monitors", { body: { name: "x", type: "ssh", target: "h", ssh: { username: "root", fingerprint: FP_A } } });
    expect(noUrl.status).toBe(409);
    await call("PUT", "settings", { body: { keys_url: KEYS_URL } });
    const r = await call("POST", "monitors", { body: { name: "x", type: "ssh", target: "h", ssh: { username: "root", fingerprint: "SHA256:nope" } } });
    expect(r.status).toBe(422);
    expect(await r.json()).toMatchObject({ error: "key_not_in_keyring" });
  });

  it("applies the dashboard's rules: inline public key ok, private key refused", async () => {
    const inline = await call("POST", "monitors", { body: { name: "i", type: "ssh", target: "h", ssh: { username: "deploy", public_key: keyB.public } } });
    expect(inline.status).toBe(201);
    expect(((await inline.json()) as any).monitor.ssh.key_source).toBe("inline");
    const priv = await call("POST", "monitors", { body: { name: "p", type: "ssh", target: "h", ssh: { username: "deploy", public_key: keyB.private } } });
    expect(priv.status).toBe(422);
    expect(((await priv.json()) as any).message).toMatch(/private key/);
    expect((await call("POST", "monitors", { body: { name: "k", type: "keyword", target: "https://x.io" } })).status).toBe(422);
    expect((await call("POST", "monitors", { body: { name: "k", type: "ftp", target: "x" } })).status).toBe(422);
    expect((await call("POST", "monitors", { body: { name: "k", type: "http", target: "https://x.io", interval_s: 5 } })).status).toBe(422);
  });

  it("patches, pauses, lists incidents and deletes", async () => {
    const created = (await (await call("POST", "monitors", { body: { name: "site", type: "http", target: "https://x.io" } })).json()) as any;
    const id = created.monitor.id;
    const p = await call("PATCH", `monitors/${id}`, { body: { enabled: false, name: "site 2", interval_s: 300 } });
    expect(p.status).toBe(200);
    expect(((await p.json()) as any).monitor).toMatchObject({ enabled: false, name: "site 2", interval_s: 300 });
    expect(await (await call("GET", `monitors/${id}/incidents`)).json()).toEqual({ incidents: [] });
    expect((await call("DELETE", `monitors/${id}`)).status).toBe(200);
    expect((await call("DELETE", `monitors/${id}`)).status).toBe(404);
  });

  it("keeps an SSH key through a rename", async () => {
    const c = (await (await call("POST", "monitors", { body: { name: "s", type: "ssh", target: "h", ssh: { username: "deploy", public_key: keyB.public } } })).json()) as any;
    const r = await call("PATCH", `monitors/${c.monitor.id}`, { body: { name: "renamed" } });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).monitor.ssh).toMatchObject({ username: "deploy", fingerprint: FP_B });
  });

  it("scopes to the user: bob cannot see or touch alice's monitor", async () => {
    const c = (await (await call("POST", "monitors", { body: { name: "a", type: "http", target: "https://a.io" } })).json()) as any;
    const id = c.monitor.id;
    const asBob = { email: "bob@example.com" };
    expect(((await (await call("GET", "monitors", asBob)).json()) as any).monitors).toEqual([]);
    expect((await call("GET", `monitors/${id}`, asBob)).status).toBe(404);
    expect((await call("PATCH", `monitors/${id}`, { ...asBob, body: { enabled: false } })).status).toBe(404);
    expect((await call("DELETE", `monitors/${id}`, asBob)).status).toBe(404);
    expect((await call("GET", `monitors/${id}/incidents`, asBob)).status).toBe(404);
    expect(db.monitors).toHaveLength(1);
    expect(db.monitors[0].enabled).toBe(true);
  });

  it("does not route unknown paths", async () => {
    expect((await call("GET", "nope")).status).toBe(404);
    expect((await call("DELETE", "settings")).status).toBe(405);
  });
});

describe("keyring resolution in the worker", () => {
  const snapshot = "ssh-ed25519 " + (parsePublicKey(keyA.public) as any).key.getPublicSSH().toString("base64");
  const config = { username: "root", fingerprint: FP_A, keys_url: KEYS_URL, public_key: snapshot };

  it("uses the keyring's current key", async () => {
    expect(await resolveSshKey(config, { fetchImpl: fakeFetch })).toEqual({ publicKey: snapshot });
  });

  it("reports a key removed from the keyring", async () => {
    ringKeys = ringKeys.filter((k) => k.fingerprint !== FP_A);
    expect(await resolveSshKey(config, { fetchImpl: fakeFetch })).toEqual({ removed: FP_A });
  });

  it("falls back to the snapshot when the keyring cannot be fetched", async () => {
    ringStatus = 404;
    expect(await resolveSshKey(config, { fetchImpl: fakeFetch })).toEqual({ publicKey: snapshot });
    clearKeyringCache();
    const boom = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await resolveSshKey(config, { fetchImpl: boom })).toEqual({ publicKey: snapshot });
  });

  it("caches a keyring for 10 minutes", async () => {
    let calls = 0;
    const counting = (async (u: string) => (calls++, fakeFetch(u))) as unknown as typeof fetch;
    await fetchKeyring(KEYS_URL, { fetchImpl: counting, now: 0 });
    await fetchKeyring(KEYS_URL, { fetchImpl: counting, now: 9 * 60_000 });
    expect(calls).toBe(1);
    await fetchKeyring(KEYS_URL, { fetchImpl: counting, now: 11 * 60_000 });
    expect(calls).toBe(2);
  });

  it("caps the keyring body at 64 KB", async () => {
    const big = (async () => new Response("x".repeat(70_000))) as unknown as typeof fetch;
    expect(await fetchKeyring(KEYS_URL, { fetchImpl: big, fresh: true })).toEqual({ ok: false, error: "keyring response over 64 KB" });
  });

  it("checkSsh is DOWN with 'key <fp> removed from keyring'", async () => {
    ringKeys = [];
    // Seed the cache the worker reads (it uses the global fetch otherwise).
    await fetchKeyring(KEYS_URL, { fetchImpl: fakeFetch, fresh: true });
    const m = { id: "m", project_id: "p", name: "n", type: "ssh", target: "127.0.0.1:1", config, interval_s: 60, timeout_s: 1 } as unknown as MonitorRow;
    expect(await checkSsh(m)).toEqual({ ok: false, responseMs: null, statusCode: null, error: `key ${FP_A} removed from keyring` });
  });
});

describe("shared monitor validation", () => {
  it("matches the dashboard defaults", () => {
    const r = buildMonitorFields({ name: " n ", type: "http", target: " https://x.io ", intervalS: 30 });
    expect(r).toEqual({ ok: true, fields: { name: "n", type: "http", target: "https://x.io", config: {}, interval_s: 60 } });
    expect(buildMonitorFields({ name: "n", type: "ssh", target: "h", username: "bad user", publicKey: keyA.public })).toEqual({ ok: false, error: "A valid SSH username is required." });
  });
});
