// A user's logicsrc keyring share link (https://app.logicsrc.com/k/lks_….json)
// lists the PUBLIC halves of their SSH keys. Fleet SSH monitors made from the
// partner uptime API point at a key by fingerprint; the worker resolves the key
// from this list on each check, so removing a key from the keyring turns its
// monitors DOWN, and a keyring that cannot be fetched falls back to the public
// key snapshotted when the monitor was made.
//
// Fetch rules: HTTPS only, host app.logicsrc.com only, no redirects, 5s timeout,
// 64 KB cap, results cached 10 minutes per URL (per process).
import { fingerprint, parsePublicKey } from "./ssh-auth-probe";

export const KEYRING_HOST = "app.logicsrc.com";
export const KEYS_URL_RE = /^https:\/\/app\.logicsrc\.com\/k\/lks_[A-Za-z0-9_-]{20,128}\.json$/;
export const KEYRING_CACHE_MS = 10 * 60_000;
const TIMEOUT_MS = 5_000;
const MAX_BYTES = 64 * 1024;

export interface KeyringKey {
  name: string;
  type: string;
  public_key: string;
  fingerprint: string;
  comment: string;
}

export type KeyringResult = { ok: true; keys: KeyringKey[] } | { ok: false; error: string };

export function isKeysUrl(v: unknown): v is string {
  if (typeof v !== "string" || !KEYS_URL_RE.test(v)) return false;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && u.hostname === KEYRING_HOST && !u.port && !u.username && !u.password;
  } catch {
    return false;
  }
}

const cache = new Map<string, { at: number; result: KeyringResult }>();

export function clearKeyringCache(): void {
  cache.clear();
}

async function readCapped(res: Response): Promise<string | null> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Keep only well-formed SSH public keys; the fingerprint is recomputed, not trusted. */
export function normalizeKeys(body: unknown): KeyringKey[] {
  const list = (body as { keys?: unknown })?.keys;
  if (!Array.isArray(list)) return [];
  const out: KeyringKey[] = [];
  for (const raw of list.slice(0, 200)) {
    const k = raw as Record<string, unknown>;
    if (typeof k?.public_key !== "string") continue;
    const parsed = parsePublicKey(k.public_key);
    if ("error" in parsed) continue;
    out.push({
      name: typeof k.name === "string" ? k.name.slice(0, 200) : "",
      type: parsed.key.type,
      public_key: parsed.key.type + " " + parsed.key.getPublicSSH().toString("base64"),
      fingerprint: fingerprint(parsed.key),
      comment: typeof k.comment === "string" ? k.comment.slice(0, 200) : parsed.key.comment || "",
    });
  }
  return out;
}

export async function fetchKeyring(
  url: string,
  opts: { fetchImpl?: typeof fetch; now?: number; fresh?: boolean } = {},
): Promise<KeyringResult> {
  if (!isKeysUrl(url)) return { ok: false, error: "keys_url is not a logicsrc keyring share link" };
  const now = opts.now ?? Date.now();
  const hit = cache.get(url);
  if (!opts.fresh && hit && now - hit.at < KEYRING_CACHE_MS) return hit.result;

  let result: KeyringResult;
  try {
    const res = await (opts.fetchImpl ?? fetch)(url, {
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: "application/json", "user-agent": "CrawlProof-Uptime/1.0" },
    });
    if (!res.ok) {
      result = { ok: false, error: `keyring returned ${res.status}` };
    } else {
      const text = await readCapped(res);
      if (text === null) result = { ok: false, error: "keyring response over 64 KB" };
      else result = { ok: true, keys: normalizeKeys(JSON.parse(text)) };
    }
  } catch (e) {
    result = { ok: false, error: `keyring fetch failed: ${(e as Error).message}` };
  }
  // Failures are cached briefly too, so a dead keyring is not hammered every sweep.
  cache.set(url, { at: result.ok ? now : now - KEYRING_CACHE_MS + 60_000, result });
  return result;
}

/**
 * Which public key an SSH monitor should offer this check.
 *  - no keys_url: the stored public_key (an inline key)
 *  - keyring reachable and has the fingerprint: that key
 *  - keyring reachable without it: removed (the monitor goes DOWN)
 *  - keyring unreachable: the snapshot public_key
 */
export async function resolveSshKey(
  config: Record<string, unknown>,
  opts: { fetchImpl?: typeof fetch; now?: number } = {},
): Promise<{ publicKey: string } | { removed: string }> {
  const snapshot = String(config.public_key ?? "");
  const keysUrl = config.keys_url;
  const fp = typeof config.fingerprint === "string" ? config.fingerprint : "";
  if (typeof keysUrl !== "string" || !keysUrl || !fp) return { publicKey: snapshot };
  const ring = await fetchKeyring(keysUrl, opts);
  if (!ring.ok) return { publicKey: snapshot };
  const key = ring.keys.find((k) => k.fingerprint === fp);
  return key ? { publicKey: key.public_key } : { removed: fp };
}
