// Mailbox autodiscovery — turn "anthony@profullstack.com" into the IMAP and
// SMTP settings for that mailbox, without the user hunting through their
// host's docs for a hostname and a port.
//
// Nothing here is authenticated and nothing is trusted blindly: discovery
// returns a *proposal* plus the trail of how it was found, and the caller is
// expected to show that to the user for confirmation before a password is
// ever typed. `confident` says whether we read real config or merely guessed.
//
// The ladder, most authoritative first:
//
//   1. SRV records (RFC 6186) — the domain owner stating it in DNS.
//   2. Thunderbird autoconfig XML at autoconfig.<domain> or
//      <domain>/.well-known/autoconfig.
//   3. Outlook autodiscover XML (POST) at autodiscover.<domain>.
//   4. Mozilla's ISPDB, for domains that publish nothing themselves.
//   5. MX-to-provider mapping — the big hosts have fixed, documented settings.
//   6. Convention (imap.<domain>/smtp.<domain>), flagged as a guess.
//
// A wrinkle worth knowing, because it is the common case rather than the
// exotic one: Forward Email, Fastmail and friends tell customers to CNAME
// autoconfig.<domain> at the provider, but their TLS certificate only covers
// the *provider's* names. Fetching https://autoconfig.<customer-domain>/ then
// fails certificate validation. Rather than disable verification — which
// would hand any network attacker the ability to point a mailbox at their own
// server — we resolve the CNAME and re-ask the provider under its own name,
// where the certificate is valid.

import dns from "node:dns/promises";
import net from "node:net";

export type MailboxProtocol = "imap" | "smtp" | "pop3";
export type SocketType = "SSL" | "STARTTLS" | "plain";

export type MailboxServer = {
  protocol: MailboxProtocol;
  host: string;
  port: number;
  socket: SocketType;
  username: string;
};

export type DiscoverySource =
  | "srv"
  | "autoconfig"
  | "autoconfig-cname"
  | "well-known"
  | "autodiscover"
  | "autodiscover-cname"
  | "ispdb"
  | "mx-provider"
  | "convention";

export type DiscoveryAttempt = {
  method: string;
  ok: boolean;
  note: string;
};

export type MailboxDiscovery = {
  email: string;
  domain: string;
  source: DiscoverySource;
  /** One sentence for the confirmation screen: where these values came from. */
  sourceDetail: string;
  providerName: string | null;
  imap: MailboxServer | null;
  smtp: MailboxServer | null;
  /** False when the values are a convention guess rather than published config. */
  confident: boolean;
  attempts: DiscoveryAttempt[];
};

const FETCH_TIMEOUT_MS = 8_000;
const MAX_BODY_BYTES = 256 * 1024;

export function splitEmail(email: string): { local: string; domain: string } | null {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return null;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return null;
  if (/\s/.test(local)) return null;
  return { local, domain };
}

// Autoconfig/autodiscover express the username as a template so one document
// can serve every mailbox on the domain.
function expandUsername(template: string, email: string, local: string): string {
  const t = template.trim();
  if (!t) return email;
  return t
    .replace(/%EMAILADDRESS%/gi, email)
    .replace(/%EMAILLOCALPART%/gi, local)
    .replace(/%USER%/gi, local);
}

/**
 * Reject hosts that resolve into private space.
 *
 * Discovery fetches URLs derived from user input, so without this a signup
 * with a hand-picked domain could aim our server at internal addresses. Hosts
 * are resolved and every answer checked, so a public name that resolves to
 * 127.0.0.1 is caught too.
 */
async function hostIsPublic(host: string): Promise<{ ok: true } | { ok: false; error: string }> {
  let addrs: string[];
  if (net.isIP(host)) {
    addrs = [host];
  } else {
    try {
      const looked = await dns.lookup(host, { all: true });
      addrs = looked.map((a) => a.address);
    } catch {
      return { ok: false, error: "hostname does not resolve" };
    }
  }
  if (!addrs.length) return { ok: false, error: "hostname does not resolve" };
  if (addrs.some((addr) => isPrivateAddress(addr))) {
    return { ok: false, error: "hostname resolves to a private address" };
  }
  return { ok: true };
}

export function isPrivateAddress(addr: string): boolean {
  if (net.isIPv4(addr)) {
    const [a, b] = addr.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  if (net.isIPv6(addr)) {
    const v6 = addr.toLowerCase();
    if (v6 === "::1" || v6 === "::") return true;
    if (v6.startsWith("fe80") || v6.startsWith("fc") || v6.startsWith("fd")) return true;
    // IPv4-mapped: defer to the v4 rules.
    const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }
  return true;
}

async function safeFetchText(
  url: string,
  init?: { method?: "GET" | "POST"; body?: string; contentType?: string },
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "bad URL" };
  }
  if (parsed.protocol !== "https:") return { ok: false, error: "not https" };
  const routable = await hostIsPublic(parsed.hostname);
  if (!routable.ok) return { ok: false, error: routable.error };
  try {
    const res = await fetch(url, {
      method: init?.method ?? "GET",
      redirect: "follow",
      headers: init?.contentType ? { "content-type": init.contentType } : undefined,
      body: init?.body,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BODY_BYTES) return { ok: false, error: "response too large" };
    return { ok: true, text: new TextDecoder().decode(buf) };
  } catch (error) {
    // Certificate failures land here, and for CNAME'd vanity hostnames that
    // is the expected outcome rather than an error worth surfacing.
    const message = error instanceof Error ? error.message : "fetch failed";
    return { ok: false, error: message };
  }
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

function tag(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1].trim() : null;
}

function normalizeSocket(raw: string | null, port: number): SocketType {
  const v = (raw ?? "").trim().toUpperCase();
  if (v === "SSL" || v === "TLS") return "SSL";
  if (v === "STARTTLS") return "STARTTLS";
  if (v === "PLAIN" || v === "NONE") return "plain";
  // Autodiscover says <SSL>on</SSL> rather than naming the socket type, so
  // fall back to what the port conventionally means.
  if (v === "ON") return port === 587 || port === 143 ? "STARTTLS" : "SSL";
  if (v === "OFF") return "plain";
  return port === 993 || port === 465 || port === 995 ? "SSL" : "STARTTLS";
}

/** Parse a Thunderbird autoconfig `clientConfig` document. */
export function parseAutoconfig(
  xml: string,
  email: string,
  local: string,
): { imap: MailboxServer | null; smtp: MailboxServer | null; providerName: string | null } {
  const providerName = tag(xml, "displayName");
  let imap: MailboxServer | null = null;
  let smtp: MailboxServer | null = null;

  const incoming = [...xml.matchAll(/<incomingServer[^>]*type="([^"]+)"[^>]*>([\s\S]*?)<\/incomingServer>/gi)];
  for (const [, type, block] of incoming) {
    if (type.toLowerCase() !== "imap") continue;
    const host = tag(block, "hostname");
    const port = Number(tag(block, "port") ?? 0);
    if (!host || !port) continue;
    imap = {
      protocol: "imap",
      host,
      port,
      socket: normalizeSocket(tag(block, "socketType"), port),
      username: expandUsername(tag(block, "username") ?? "", email, local),
    };
    break;
  }

  const outgoing = xml.match(/<outgoingServer[^>]*>([\s\S]*?)<\/outgoingServer>/i);
  if (outgoing) {
    const block = outgoing[1];
    const host = tag(block, "hostname");
    const port = Number(tag(block, "port") ?? 0);
    if (host && port) {
      smtp = {
        protocol: "smtp",
        host,
        port,
        socket: normalizeSocket(tag(block, "socketType"), port),
        username: expandUsername(tag(block, "username") ?? "", email, local),
      };
    }
  }

  return { imap, smtp, providerName };
}

/** Parse an Outlook `Autodiscover` POX response. */
export function parseAutodiscover(
  xml: string,
  email: string,
  local: string,
): { imap: MailboxServer | null; smtp: MailboxServer | null } {
  let imap: MailboxServer | null = null;
  let smtp: MailboxServer | null = null;

  for (const [, block] of xml.matchAll(/<Protocol>([\s\S]*?)<\/Protocol>/gi)) {
    const type = (tag(block, "Type") ?? "").toUpperCase();
    const host = tag(block, "Server");
    const port = Number(tag(block, "Port") ?? 0);
    if (!host || !port) continue;
    const server: MailboxServer = {
      protocol: type === "SMTP" ? "smtp" : "imap",
      host,
      port,
      socket: normalizeSocket(tag(block, "SSL"), port),
      username: expandUsername(tag(block, "LoginName") ?? "", email, local),
    };
    if (type === "IMAP" && !imap) imap = server;
    if (type === "SMTP" && !smtp) smtp = server;
  }

  return { imap, smtp };
}

// ---------------------------------------------------------------------------
// MX-to-provider mapping
// ---------------------------------------------------------------------------

type ProviderProfile = {
  name: string;
  imap: { host: string; port: number; socket: SocketType };
  smtp: { host: string; port: number; socket: SocketType };
  /** Set when the provider requires an app-specific password, not the login one. */
  passwordNote?: string;
};

const MX_PROVIDERS: Array<{ match: RegExp; profile: ProviderProfile }> = [
  {
    match: /(^|\.)forwardemail\.net$/i,
    profile: {
      name: "Forward Email",
      imap: { host: "imap.forwardemail.net", port: 993, socket: "SSL" },
      smtp: { host: "smtp.forwardemail.net", port: 465, socket: "SSL" },
      passwordNote:
        "Forward Email uses a per-alias generated password, not your account password — create one in the Forward Email dashboard.",
    },
  },
  {
    match: /(^|\.)google\.com$|(^|\.)googlemail\.com$/i,
    profile: {
      name: "Google Workspace / Gmail",
      imap: { host: "imap.gmail.com", port: 993, socket: "SSL" },
      smtp: { host: "smtp.gmail.com", port: 465, socket: "SSL" },
      passwordNote:
        "Gmail rejects your normal password over IMAP/SMTP. Generate an App Password (requires 2-Step Verification).",
    },
  },
  {
    match: /(^|\.)outlook\.com$|(^|\.)office365\.com$|(^|\.)protection\.outlook\.com$/i,
    profile: {
      name: "Microsoft 365 / Outlook",
      imap: { host: "outlook.office365.com", port: 993, socket: "SSL" },
      smtp: { host: "smtp.office365.com", port: 587, socket: "STARTTLS" },
      passwordNote:
        "Microsoft disables basic auth on many tenants. If the check fails, an admin must allow SMTP AUTH or you need an app password.",
    },
  },
  {
    match: /(^|\.)messagingengine\.com$|(^|\.)fastmail\.com$/i,
    profile: {
      name: "Fastmail",
      imap: { host: "imap.fastmail.com", port: 993, socket: "SSL" },
      smtp: { host: "smtp.fastmail.com", port: 465, socket: "SSL" },
      passwordNote: "Fastmail requires an app password with Mail access.",
    },
  },
  {
    match: /(^|\.)zoho\.com$|(^|\.)zoho\.eu$/i,
    profile: {
      name: "Zoho Mail",
      imap: { host: "imap.zoho.com", port: 993, socket: "SSL" },
      smtp: { host: "smtp.zoho.com", port: 465, socket: "SSL" },
    },
  },
  {
    match: /(^|\.)icloud\.com$|(^|\.)me\.com$/i,
    profile: {
      name: "iCloud Mail",
      imap: { host: "imap.mail.me.com", port: 993, socket: "SSL" },
      smtp: { host: "smtp.mail.me.com", port: 587, socket: "STARTTLS" },
      passwordNote: "iCloud requires an app-specific password.",
    },
  },
  {
    match: /(^|\.)yahoodns\.net$|(^|\.)yahoo\.com$/i,
    profile: {
      name: "Yahoo Mail",
      imap: { host: "imap.mail.yahoo.com", port: 993, socket: "SSL" },
      smtp: { host: "smtp.mail.yahoo.com", port: 465, socket: "SSL" },
      passwordNote: "Yahoo requires an app password.",
    },
  },
  {
    match: /(^|\.)protonmail\.ch$|(^|\.)proton\.me$/i,
    profile: {
      name: "Proton Mail",
      imap: { host: "127.0.0.1", port: 1143, socket: "STARTTLS" },
      smtp: { host: "127.0.0.1", port: 1025, socket: "STARTTLS" },
      passwordNote:
        "Proton only exposes IMAP/SMTP through Proton Mail Bridge running on your own machine, so it cannot be connected from a server.",
    },
  },
  {
    match: /(^|\.)mailgun\.org$|(^|\.)mxlogic\.net$|(^|\.)migadu\.com$/i,
    profile: {
      name: "Migadu",
      imap: { host: "imap.migadu.com", port: 993, socket: "SSL" },
      smtp: { host: "smtp.migadu.com", port: 465, socket: "SSL" },
    },
  },
];

export function providerFromMx(mxHosts: string[]): ProviderProfile | null {
  for (const host of mxHosts) {
    const clean = host.replace(/\.$/, "").toLowerCase();
    for (const { match, profile } of MX_PROVIDERS) {
      if (match.test(clean)) return profile;
    }
  }
  return null;
}

/** Providers that cannot work from a server, regardless of credentials. */
export function unreachableProvider(d: MailboxDiscovery): string | null {
  if (d.imap && isPrivateAddress(d.imap.host)) {
    return d.providerName
      ? `${d.providerName} only exposes mail through a local bridge, so it can't be connected from CrawlProof's servers.`
      : "This provider only exposes mail through a local bridge.";
  }
  return null;
}

// ---------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------

async function resolveCnameTarget(host: string): Promise<string | null> {
  try {
    const chain = await dns.resolveCname(host);
    const target = chain[0]?.replace(/\.$/, "");
    return target && target !== host ? target : null;
  } catch {
    return null;
  }
}

async function trySrv(
  domain: string,
  email: string,
  local: string,
  attempts: DiscoveryAttempt[],
): Promise<{ imap: MailboxServer | null; smtp: MailboxServer | null }> {
  const lookup = async (
    record: string,
    protocol: MailboxProtocol,
    socket: SocketType,
  ): Promise<MailboxServer | null> => {
    try {
      const rows = await dns.resolveSrv(`${record}.${domain}`);
      const best = rows
        .filter((r) => r.name && r.name !== ".")
        .sort((a, b) => a.priority - b.priority || b.weight - a.weight)[0];
      if (!best) return null;
      return {
        protocol,
        host: best.name.replace(/\.$/, ""),
        port: best.port,
        socket,
        username: email,
      };
    } catch {
      return null;
    }
  };

  const imap =
    (await lookup("_imaps._tcp", "imap", "SSL")) ?? (await lookup("_imap._tcp", "imap", "STARTTLS"));
  const smtp =
    (await lookup("_submissions._tcp", "smtp", "SSL")) ??
    (await lookup("_submission._tcp", "smtp", "STARTTLS"));

  attempts.push({
    method: "SRV records (RFC 6186)",
    ok: Boolean(imap || smtp),
    note: imap || smtp ? "found" : "no _imaps/_submissions SRV records published",
  });

  // `local` is unused for SRV — the record only names host and port, and the
  // username convention for SRV-discovered mailboxes is the full address.
  void local;
  return { imap, smtp };
}

async function tryAutoconfig(
  domain: string,
  email: string,
  local: string,
  attempts: DiscoveryAttempt[],
): Promise<{
  parsed: ReturnType<typeof parseAutoconfig>;
  source: DiscoverySource;
  detail: string;
} | null> {
  const query = `mail/config-v1.1.xml?emailaddress=${encodeURIComponent(email)}`;

  const direct = await safeFetchText(`https://autoconfig.${domain}/${query}`);
  if (direct.ok) {
    const parsed = parseAutoconfig(direct.text, email, local);
    if (parsed.imap || parsed.smtp) {
      attempts.push({ method: `autoconfig.${domain}`, ok: true, note: "served a config" });
      return {
        parsed,
        source: "autoconfig",
        detail: `published by your domain at autoconfig.${domain}`,
      };
    }
  }

  // The CNAME retry described at the top of the file: the vanity hostname is
  // right but its certificate belongs to the provider, so ask the provider.
  const cname = await resolveCnameTarget(`autoconfig.${domain}`);
  if (cname) {
    const viaCname = await safeFetchText(`https://${cname}/${query}`);
    if (viaCname.ok) {
      const parsed = parseAutoconfig(viaCname.text, email, local);
      if (parsed.imap || parsed.smtp) {
        attempts.push({
          method: `autoconfig.${domain}`,
          ok: true,
          note: `CNAME points at ${cname}; that host's certificate is valid, so the config was read there (${direct.ok ? "direct fetch returned nothing usable" : direct.error})`,
        });
        return {
          parsed,
          source: "autoconfig-cname",
          detail: `published by your mail host: autoconfig.${domain} is a CNAME to ${cname}`,
        };
      }
    }
  }
  attempts.push({
    method: `autoconfig.${domain}`,
    ok: false,
    note: direct.ok ? "config had no usable servers" : direct.error,
  });

  const wellKnown = await safeFetchText(`https://${domain}/.well-known/autoconfig/${query}`);
  if (wellKnown.ok) {
    const parsed = parseAutoconfig(wellKnown.text, email, local);
    if (parsed.imap || parsed.smtp) {
      attempts.push({ method: `${domain}/.well-known/autoconfig`, ok: true, note: "served a config" });
      return {
        parsed,
        source: "well-known",
        detail: `published by your domain at ${domain}/.well-known/autoconfig`,
      };
    }
  }
  attempts.push({
    method: `${domain}/.well-known/autoconfig`,
    ok: false,
    note: wellKnown.ok ? "config had no usable servers" : wellKnown.error,
  });

  return null;
}

const AUTODISCOVER_BODY = (email: string) =>
  `<?xml version="1.0" encoding="utf-8"?><Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/requestschema/2006"><Request><EMailAddress>${email.replace(/[<>&]/g, "")}</EMailAddress><AcceptableResponseSchema>http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a</AcceptableResponseSchema></Request></Autodiscover>`;

async function tryAutodiscover(
  domain: string,
  email: string,
  local: string,
  attempts: DiscoveryAttempt[],
): Promise<{
  parsed: ReturnType<typeof parseAutodiscover>;
  source: DiscoverySource;
  detail: string;
} | null> {
  const post = (host: string) =>
    safeFetchText(`https://${host}/autodiscover/autodiscover.xml`, {
      method: "POST",
      body: AUTODISCOVER_BODY(email),
      contentType: "text/xml; charset=utf-8",
    });

  const direct = await post(`autodiscover.${domain}`);
  if (direct.ok) {
    const parsed = parseAutodiscover(direct.text, email, local);
    if (parsed.imap || parsed.smtp) {
      attempts.push({ method: `autodiscover.${domain}`, ok: true, note: "served a config" });
      return {
        parsed,
        source: "autodiscover",
        detail: `published by your domain at autodiscover.${domain} (Outlook autodiscover)`,
      };
    }
  }

  const cname = await resolveCnameTarget(`autodiscover.${domain}`);
  if (cname) {
    const viaCname = await post(cname);
    if (viaCname.ok) {
      const parsed = parseAutodiscover(viaCname.text, email, local);
      if (parsed.imap || parsed.smtp) {
        attempts.push({
          method: `autodiscover.${domain}`,
          ok: true,
          note: `CNAME points at ${cname}; config read there under a valid certificate`,
        });
        return {
          parsed,
          source: "autodiscover-cname",
          detail: `published by your mail host: autodiscover.${domain} is a CNAME to ${cname} (Outlook autodiscover)`,
        };
      }
    }
  }

  attempts.push({
    method: `autodiscover.${domain}`,
    ok: false,
    note: direct.ok ? "response had no usable protocols" : direct.error,
  });
  return null;
}

async function tryIspdb(
  domain: string,
  email: string,
  local: string,
  attempts: DiscoveryAttempt[],
): Promise<ReturnType<typeof parseAutoconfig> | null> {
  const res = await safeFetchText(`https://autoconfig.thunderbird.net/v1.1/${domain}`);
  if (res.ok) {
    const parsed = parseAutoconfig(res.text, email, local);
    if (parsed.imap || parsed.smtp) {
      attempts.push({ method: "Mozilla ISPDB", ok: true, note: "known provider" });
      return parsed;
    }
  }
  attempts.push({
    method: "Mozilla ISPDB",
    ok: false,
    note: res.ok ? "no usable servers" : res.error,
  });
  return null;
}

/**
 * Work out IMAP/SMTP settings for `email`.
 *
 * Always resolves — a domain that publishes nothing still gets a
 * `confident: false` convention guess, which the UI presents as something to
 * check rather than something to trust.
 */
export async function discoverMailbox(email: string): Promise<MailboxDiscovery | null> {
  const parts = splitEmail(email);
  if (!parts) return null;
  const { local, domain } = parts;
  const address = `${local}@${domain}`;
  const attempts: DiscoveryAttempt[] = [];

  const base = { email: address, domain, attempts };

  const srv = await trySrv(domain, address, local, attempts);
  if (srv.imap && srv.smtp) {
    return {
      ...base,
      source: "srv",
      sourceDetail: `published by your domain as DNS SRV records`,
      providerName: null,
      imap: srv.imap,
      smtp: srv.smtp,
      confident: true,
    };
  }

  const autoconfig = await tryAutoconfig(domain, address, local, attempts);
  if (autoconfig) {
    return {
      ...base,
      source: autoconfig.source,
      sourceDetail: autoconfig.detail,
      providerName: autoconfig.parsed.providerName,
      imap: autoconfig.parsed.imap ?? srv.imap,
      smtp: autoconfig.parsed.smtp ?? srv.smtp,
      confident: true,
    };
  }

  const autodiscover = await tryAutodiscover(domain, address, local, attempts);
  if (autodiscover) {
    return {
      ...base,
      source: autodiscover.source,
      sourceDetail: autodiscover.detail,
      providerName: null,
      imap: autodiscover.parsed.imap ?? srv.imap,
      smtp: autodiscover.parsed.smtp ?? srv.smtp,
      confident: true,
    };
  }

  const ispdb = await tryIspdb(domain, address, local, attempts);
  if (ispdb) {
    return {
      ...base,
      source: "ispdb",
      sourceDetail: "matched in Mozilla's public provider database",
      providerName: ispdb.providerName,
      imap: ispdb.imap ?? srv.imap,
      smtp: ispdb.smtp ?? srv.smtp,
      confident: true,
    };
  }

  let mxHosts: string[] = [];
  try {
    const mx = await dns.resolveMx(domain);
    mxHosts = mx.sort((a, b) => a.priority - b.priority).map((m) => m.exchange);
  } catch {
    mxHosts = [];
  }

  const provider = providerFromMx(mxHosts);
  if (provider) {
    attempts.push({
      method: "MX records",
      ok: true,
      note: `${mxHosts.join(", ")} → ${provider.name}`,
    });
    return {
      ...base,
      source: "mx-provider",
      sourceDetail: `recognised from your MX records (${mxHosts[0]}) as ${provider.name}`,
      providerName: provider.name,
      imap: { protocol: "imap", ...provider.imap, username: address },
      smtp: { protocol: "smtp", ...provider.smtp, username: address },
      confident: true,
    };
  }

  attempts.push({
    method: "MX records",
    ok: false,
    note: mxHosts.length ? `${mxHosts.join(", ")} — unrecognised provider` : "no MX records",
  });

  return {
    ...base,
    source: "convention",
    sourceDetail:
      "nothing published — these are the conventional defaults and are a guess, so check them against your mail host's documentation",
    providerName: null,
    imap: { protocol: "imap", host: `imap.${domain}`, port: 993, socket: "SSL", username: address },
    smtp: { protocol: "smtp", host: `smtp.${domain}`, port: 465, socket: "SSL", username: address },
    confident: false,
  };
}

/** The provider-specific password warning, if we recognised the provider. */
export function passwordNoteFor(discovery: MailboxDiscovery): string | null {
  const host = `${discovery.imap?.host ?? ""} ${discovery.smtp?.host ?? ""}`.toLowerCase();
  for (const { profile } of MX_PROVIDERS) {
    if (!profile.passwordNote) continue;
    const known = `${profile.imap.host} ${profile.smtp.host}`.toLowerCase();
    const names = known.split(/\s+/).filter(Boolean);
    if (names.some((n) => host.includes(n))) return profile.passwordNote;
  }
  return null;
}
