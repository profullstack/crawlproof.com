// SSH login check that never logs in and never holds a private key.
//
// SSH lets a client ask "would you accept this public key?" before it signs
// anything (RFC 4252 §7, a publickey request with has-signature = false). The
// server answers SSH_MSG_USERAUTH_PK_OK if the key is in that user's
// authorized_keys. ssh2 sends that query first and only asks its agent for a
// signature once the server has said PK_OK, so an agent that holds just the
// public key and refuses to sign tells us the answer and ends the handshake
// before any session exists. sshd logs it as a [preauth] disconnect.
import { createHash } from "node:crypto";
import { BaseAgent, Client, utils, type ParsedKey } from "ssh2";

export type SshAuthResult =
  | { reachable: true; accepted: boolean; responseMs: number }
  | { reachable: false; error: string };

export interface SshAuthProbe {
  host: string;
  port: number;
  username: string;
  publicKey: string;
  timeoutMs: number;
}

/**
 * Parses an OpenSSH public key line ("ssh-ed25519 AAAA… comment"). Returns an
 * error string for anything else, and refuses private keys outright so one is
 * never stored.
 */
export function parsePublicKey(text: string): { key: ParsedKey } | { error: string } {
  const trimmed = text.trim();
  if (!trimmed) return { error: "Public key is required." };
  if (/PRIVATE KEY/.test(trimmed)) {
    return { error: "That is a private key. Paste the public key (the .pub file) instead." };
  }
  const parsed = utils.parseKey(trimmed);
  if (parsed instanceof Error) return { error: `Not a valid SSH public key: ${parsed.message}` };
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!key || key.isPrivateKey()) {
    return { error: "That is a private key. Paste the public key (the .pub file) instead." };
  }
  return { key };
}

/** SHA256 fingerprint in the form `ssh-keygen -l` prints, for display. */
export function fingerprint(key: ParsedKey): string {
  const hash = createHash("sha256").update(key.getPublicSSH()).digest("base64");
  return `SHA256:${hash.replace(/=+$/, "")}`;
}

export function probeSshAuth(opts: SshAuthProbe): Promise<SshAuthResult> {
  const parsed = parsePublicKey(opts.publicKey);
  if ("error" in parsed) return Promise.resolve({ reachable: false, error: parsed.error });
  const key = parsed.key;

  return new Promise((resolve) => {
    const started = Date.now();
    const conn = new Client();
    let settled = false;
    let accepted = false;
    const timer = setTimeout(() => finish({ reachable: false, error: "ssh timed out" }), opts.timeoutMs);

    function finish(r: SshAuthResult) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.end();
      resolve(r);
    }

    class PublicKeyOnlyAgent extends BaseAgent {
      getIdentities(cb: (err: Error | undefined, keys?: ParsedKey[]) => void) {
        cb(undefined, [key]);
      }
      sign(_pubKey: ParsedKey, _data: Buffer, _options: unknown, cb?: (err: Error) => void) {
        // Only reached after PK_OK: the server would accept this key.
        accepted = true;
        finish({ reachable: true, accepted: true, responseMs: Date.now() - started });
        cb?.(new Error("probe does not sign"));
      }
    }

    // A real login would mean someone handed us a key that needs no signature;
    // treat it as a failure rather than leave a session open.
    conn.on("ready", () => finish({ reachable: false, error: "unexpected login without a signature" }));
    conn.on("error", (e: Error & { level?: string }) => {
      if (accepted) return;
      if (e.level === "client-authentication") {
        return finish({ reachable: true, accepted: false, responseMs: Date.now() - started });
      }
      finish({ reachable: false, error: e.message });
    });

    conn.connect({
      host: opts.host,
      port: opts.port,
      username: opts.username,
      agent: new PublicKeyOnlyAgent(),
      tryKeyboard: false,
      readyTimeout: opts.timeoutMs,
    });
  });
}
