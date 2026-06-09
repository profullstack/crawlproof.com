// openssl-based TLS + certificate inspection for the Posture engine.
//
// We drive `openssl s_client` (OpenSSL upstream — actively maintained) to:
//   - probe which TLS versions the server will negotiate (1.0–1.3),
//   - capture the negotiated protocol + cipher,
//   - pull the leaf certificate and parse validity / issuer / SAN / key.
// HSTS and the HTTP→HTTPS upgrade are checked with the global fetch.
//
// The host is validated (validHost) before it becomes an openssl argument.

import { run, validHost } from "./exec";

export type TlsProtocols = {
  "TLSv1.0": boolean;
  "TLSv1.1": boolean;
  "TLSv1.2": boolean;
  "TLSv1.3": boolean;
};

export type PostureCert = {
  subject: string | null;
  issuer: string | null;
  san: string[];
  notBefore: string | null;
  notAfter: string | null;
  daysToExpiry: number | null;
  serial: string | null;
  fingerprintSha256: string | null;
  signatureAlgorithm: string | null;
  keyBits: number | null;
  selfSigned: boolean;
  expired: boolean;
};

export type PostureTls = {
  reachable: boolean;
  negotiatedProtocol: string | null;
  negotiatedCipher: string | null;
  protocols: TlsProtocols;
  cert: PostureCert | null;
  hsts: string | null;
  httpsRedirect: boolean | null;
  toolMissing: boolean;
};

const PROTO_FLAGS: Array<{ flag: string; label: keyof TlsProtocols; legacy: boolean }> = [
  { flag: "-tls1", label: "TLSv1.0", legacy: true },
  { flag: "-tls1_1", label: "TLSv1.1", legacy: true },
  { flag: "-tls1_2", label: "TLSv1.2", legacy: false },
  { flag: "-tls1_3", label: "TLSv1.3", legacy: false },
];

function sclientArgs(host: string, extra: string[]): string[] {
  return ["s_client", "-connect", `${host}:443`, "-servername", host, ...extra];
}

/**
 * A handshake truly succeeded only if a real cipher was negotiated. openssl
 * prints `Protocol  : TLSv1` and `Cipher is (NONE)` even when the server
 * REJECTS the version with a "protocol version" alert, so matching the protocol
 * line alone produces false positives — we must exclude the (NONE)/alert cases.
 */
function handshakeOk(stdout: string): boolean {
  if (/Cipher\s*(is|:)\s*\(NONE\)/.test(stdout)) return false;
  if (/alert (protocol version|handshake failure)/i.test(stdout)) return false;
  return (
    /-----BEGIN CERTIFICATE-----/.test(stdout) ||
    /New,\s*TLSv[\d.]+,\s*Cipher is \S+/.test(stdout) ||
    /Cipher\s*:\s*\S+/.test(stdout)
  );
}

async function probeProtocol(host: string, flag: string, legacy: boolean): Promise<boolean> {
  // Legacy protocols are blocked by the distro security level on modern
  // OpenSSL; drop SECLEVEL to 0 so the *server's* support is what's measured.
  const extra = legacy ? [flag, "-cipher", "DEFAULT@SECLEVEL=0"] : [flag];
  const res = await run("openssl", sclientArgs(host, extra), { input: "Q\n", timeoutMs: 8000 });
  return res.ok && handshakeOk(res.stdout);
}

function extractPem(stdout: string): string | null {
  const m = stdout.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/);
  return m ? m[0] : null;
}

function parseNegotiated(stdout: string): { protocol: string | null; cipher: string | null } {
  const proto = stdout.match(/Protocol\s*:\s*(TLSv[\d.]+)/) || stdout.match(/New,\s*(TLSv[\d.]+)/);
  const cipher =
    stdout.match(/Cipher\s*:\s*([A-Za-z0-9_-]+)/) || stdout.match(/Cipher is\s+([A-Za-z0-9_-]+)/);
  return { protocol: proto ? proto[1] : null, cipher: cipher ? cipher[1] : null };
}

async function parseCert(pem: string): Promise<PostureCert | null> {
  const fields = await run(
    "openssl",
    ["x509", "-noout", "-subject", "-issuer", "-dates", "-serial", "-fingerprint", "-sha256", "-ext", "subjectAltName"],
    { input: pem },
  );
  if (!fields.ok) return null;
  const text = await run("openssl", ["x509", "-noout", "-text"], { input: pem });

  const out = fields.stdout;
  const grab = (re: RegExp) => (out.match(re)?.[1] ?? null)?.trim() ?? null;
  const subject = grab(/^subject=(.+)$/m);
  const issuer = grab(/^issuer=(.+)$/m);
  const notBefore = grab(/^notBefore=(.+)$/m);
  const notAfter = grab(/^notAfter=(.+)$/m);
  const serial = grab(/^serial=(.+)$/m);
  const fingerprintSha256 = grab(/Fingerprint=(.+)$/m);

  const san = Array.from(out.matchAll(/DNS:([^,\s]+)/g)).map((m) => m[1]);

  let signatureAlgorithm: string | null = null;
  let keyBits: number | null = null;
  if (text.ok) {
    signatureAlgorithm = text.stdout.match(/Signature Algorithm:\s*(\S+)/)?.[1] ?? null;
    keyBits = text.stdout.match(/Public-Key:\s*\((\d+)\s*bit\)/)?.[1]
      ? Number(text.stdout.match(/Public-Key:\s*\((\d+)\s*bit\)/)![1])
      : null;
  }

  const expiryMs = notAfter ? Date.parse(notAfter) : NaN;
  const beforeMs = notBefore ? Date.parse(notBefore) : NaN;
  const now = Date.now();
  const daysToExpiry = Number.isNaN(expiryMs) ? null : Math.round((expiryMs - now) / 86_400_000);
  const expired =
    (!Number.isNaN(expiryMs) && expiryMs < now) || (!Number.isNaN(beforeMs) && beforeMs > now);

  return {
    subject,
    issuer,
    san,
    notBefore,
    notAfter,
    daysToExpiry,
    serial,
    fingerprintSha256,
    signatureAlgorithm,
    keyBits,
    selfSigned: !!subject && subject === issuer,
    expired,
  };
}

async function checkHttp(host: string): Promise<{ hsts: string | null; httpsRedirect: boolean | null }> {
  let hsts: string | null = null;
  try {
    const res = await fetch(`https://${host}/`, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
      headers: { "user-agent": "CrawlProof-Posture/1.0" },
    });
    hsts = res.headers.get("strict-transport-security");
  } catch {
    /* ignore */
  }
  let httpsRedirect: boolean | null = null;
  try {
    const res = await fetch(`http://${host}/`, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
      headers: { "user-agent": "CrawlProof-Posture/1.0" },
    });
    const loc = res.headers.get("location") ?? "";
    httpsRedirect =
      (res.status >= 300 && res.status < 400 && /^https:/i.test(loc)) || false;
  } catch {
    httpsRedirect = null;
  }
  return { hsts, httpsRedirect };
}

export async function collectPostureTls(host: string): Promise<PostureTls> {
  if (!validHost(host)) {
    throw new Error(`Posture: "${host}" is not a valid host.`);
  }

  // Main handshake (negotiates the best protocol) → cert + negotiated params.
  const main = await run("openssl", sclientArgs(host, []), { input: "Q\n", timeoutMs: 8000 });
  if (!main.ok && main.error.includes("not installed")) {
    return {
      reachable: false,
      negotiatedProtocol: null,
      negotiatedCipher: null,
      protocols: { "TLSv1.0": false, "TLSv1.1": false, "TLSv1.2": false, "TLSv1.3": false },
      cert: null,
      hsts: null,
      httpsRedirect: null,
      toolMissing: true,
    };
  }

  const reachable = main.ok && handshakeOk(main.stdout);
  const { protocol, cipher } = reachable
    ? parseNegotiated(main.stdout)
    : { protocol: null, cipher: null };
  const pem = reachable ? extractPem(main.stdout) : null;

  const [cert, protoResults, http] = await Promise.all([
    pem ? parseCert(pem) : Promise.resolve(null),
    Promise.all(PROTO_FLAGS.map((p) => probeProtocol(host, p.flag, p.legacy))),
    checkHttp(host),
  ]);

  const protocols: TlsProtocols = {
    "TLSv1.0": false,
    "TLSv1.1": false,
    "TLSv1.2": false,
    "TLSv1.3": false,
  };
  PROTO_FLAGS.forEach((p, i) => {
    protocols[p.label] = protoResults[i];
  });

  return {
    reachable,
    negotiatedProtocol: protocol,
    negotiatedCipher: cipher,
    protocols,
    cert,
    hsts: http.hsts,
    httpsRedirect: http.httpsRedirect,
    toolMissing: false,
  };
}
