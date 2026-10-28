// `crawlproof keys status|unlock|lock` — the passphrase is read from
// CRAWLPROOF_KEY_PASSPHRASE or a hidden prompt and never leaves this process:
// the CLI derives the data key locally and sends only that.
import { bytesToBase64, isSealRecord, parseTtl, unlockSeal, wipe, WrongPassphraseError } from "./crypto";

type Api = (method: "GET" | "POST", path: string, body?: Record<string, unknown>) => Promise<{ status: number; json: Record<string, unknown> }>;
type Out = { write: (l: string) => void; error: (l: string) => void };

async function readHidden(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  const stdin = process.stdin;
  return new Promise((resolve) => {
    let buf = "";
    const raw = stdin.isTTY;
    if (raw) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === "\n" || c === "\r" || c === "\u0004") {
          if (raw) stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stderr.write("\n");
          return resolve(buf);
        }
        if (c === "\u0003") process.exit(130);
        buf += c;
      }
    };
    stdin.on("data", onData);
  });
}

export async function runKeys(positional: string[], flags: Record<string, string | boolean>, api: Api, out: Out): Promise<number> {
  const sub = positional[0] ?? "status";
  if (sub === "status") {
    const r = await api("GET", "/api/keys");
    if (r.status !== 200) return out.error(String(r.json.error ?? r.status)), 1;
    const j = r.json as { state: string; expires_at: string | null; waiting: unknown; operator?: unknown };
    if (flags.json) out.write(JSON.stringify({ state: j.state, expires_at: j.expires_at, waiting: j.waiting, operator: j.operator }));
    else out.write(`${j.state}${j.expires_at ? ` until ${j.expires_at}` : ""}`);
    return j.state === "unlocked" ? 0 : 3;
  }
  if (sub === "lock") {
    const r = await api("POST", "/api/keys/lock", {});
    if (r.status !== 200) return out.error(String(r.json.error ?? r.status)), 1;
    out.write("locked");
    return 0;
  }
  if (sub === "unlock") {
    const s = await api("GET", "/api/keys");
    if (s.status !== 200) return out.error(String(s.json.error ?? s.status)), 1;
    const seal = s.json.seal;
    const userId = String(s.json.user_id ?? "");
    if (!isSealRecord(seal)) return out.error("No key passphrase set up yet: do that once at /dashboard/keys."), 1;
    const ttl = parseTtl(typeof flags.ttl === "string" ? flags.ttl : undefined, flags.operator ? 7 * 86400 : 8 * 3600);
    const pass = process.env.CRAWLPROOF_KEY_PASSPHRASE ?? (await readHidden("Key passphrase: "));
    let dek: Uint8Array;
    try {
      dek = await unlockSeal(seal, pass, userId);
    } catch (e) {
      return out.error(e instanceof WrongPassphraseError ? "wrong passphrase" : (e as Error).message), 1;
    }
    const body = { dek: bytesToBase64(dek), ttl_seconds: ttl };
    wipe(dek);
    const r = await api("POST", "/api/keys/unlock", body);
    if (r.status !== 200) return out.error(String(r.json.error ?? r.status)), 1;
    out.write(`unlocked until ${r.json.expires_at}${r.json.worker_unlocked ? "" : " (worker did not confirm)"}`);
    return 0;
  }
  out.error("usage: crawlproof keys status|unlock [--ttl 8h|7d] [--operator]|lock");
  return 2;
}
