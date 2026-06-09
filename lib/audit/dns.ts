// DNS record collector for the "DNS Analyzer" scan type. Resolves a domain's
// full DNS footprint (addressing + mail + email-auth) using the built-in
// node:dns resolver — no shell, no external deps, so there is zero
// command-injection surface. The domain is still validated against a strict
// RFC-1123 hostname pattern before any lookup as defense-in-depth.
//
// The raw collected records are handed to the AI engine (lib/audit/dns-engine)
// for analysis; the deterministic findings below give the report a useful
// baseline even if the AI step is unavailable.

import { Resolver } from "node:dns/promises";
import type { Finding } from "./types";

// RFC 1123 hostname: labels of [a-z0-9-], no leading/trailing hyphen,
// <=253 chars total, <=63 per label.
const HOSTNAME_RE =
  /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i;

// Common DKIM selectors worth probing when no provider-specific one is known.
const DKIM_SELECTORS = [
  "resend", // Resend
  "forwardemail", // ForwardEmail outbound
  "google", // Google Workspace
  "selector1", // Microsoft 365
  "selector2",
  "k1", // Mailchimp / Mandrill
  "s1", // SendGrid-style
  "s2",
  "default",
  "mail",
  "dkim",
];

// Common SRV service labels worth probing. SRV records can't be enumerated, so
// we check the well-known ones (mail, chat, calendaring, VoIP, game servers).
const SRV_SERVICES = [
  "_sip._tls",
  "_sip._tcp",
  "_sips._tcp",
  "_xmpp-server._tcp",
  "_xmpp-client._tcp",
  "_autodiscover._tcp",
  "_caldav._tcp",
  "_caldavs._tcp",
  "_carddav._tcp",
  "_carddavs._tcp",
  "_submission._tcp",
  "_imap._tcp",
  "_imaps._tcp",
  "_pop3._tcp",
  "_pop3s._tcp",
  "_ldap._tcp",
  "_matrix._tcp",
  "_minecraft._tcp",
];

export type SrvRecord = { priority: number; weight: number; port: number; name: string };

export type DnsRecords = {
  domain: string;
  a: string[];
  aaaa: string[];
  ns: string[];
  mx: Array<{ priority: number; exchange: string }>;
  soa: Record<string, unknown> | null;
  caa: Array<Record<string, unknown>>;
  txtRoot: string[];
  spf: string | null;
  dmarc: string | null;
  dkim: Array<{ selector: string; value: string }>;
  // Resend's Return-Path / bounce subdomain.
  sendSubdomain: { spf: string | null; mx: Array<{ priority: number; exchange: string }> };
  mtaSts: string[];
  tlsRpt: string[];
  bimi: string[];
  cname: Array<{ name: string; target: string }>;
  srv: Array<{ service: string; records: SrvRecord[] }>;
  dnssec: { ds: string[]; dnskey: string[]; signed: boolean };
  https: string[];
  svcb: string[];
  errors: string[];
};

// DNS-over-HTTPS (Cloudflare JSON) for record types the built-in node:dns
// resolver can't query: DS (43), DNSKEY (48), SVCB (64), HTTPS (65). Built on
// the global fetch — still no external deps and no shell. Best-effort: any
// failure resolves to an empty list so it never aborts the collection.
async function dohData(name: string, type: string, wantType: number): Promise<string[]> {
  try {
    const res = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
      { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) return [];
    const json = (await res.json()) as { Answer?: Array<{ type: number; data: string }> };
    return (json.Answer ?? []).filter((a) => a.type === wantType).map((a) => a.data);
  } catch {
    return [];
  }
}

/** Extract a bare, validated registrable hostname from a URL or hostname. */
export function domainFromTarget(input: string): string | null {
  if (typeof input !== "string") return null;
  let d = input.trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, "").replace(/[/:?#].*$/, "").replace(/\.$/, "");
  // Drop a leading www. so we analyze the registrable domain's mail records.
  d = d.replace(/^www\./, "");
  if (!HOSTNAME_RE.test(d)) return null;
  return d;
}

function makeResolver(): Resolver {
  const r = new Resolver({ timeout: 5000, tries: 2 });
  r.setServers(["1.1.1.1", "8.8.8.8"]);
  return r;
}

export async function collectDnsRecords(targetOrDomain: string): Promise<DnsRecords> {
  const domain = domainFromTarget(targetOrDomain);
  if (!domain) {
    throw new Error(`DNS Analyzer: "${targetOrDomain}" is not a valid domain.`);
  }
  const r = makeResolver();
  const errors: string[] = [];

  // Each helper swallows ENODATA/ENOTFOUND into an empty result so a single
  // missing record never aborts the whole collection.
  const txt = async (name: string): Promise<string[]> => {
    try {
      return (await r.resolveTxt(name)).map((parts) => parts.join(""));
    } catch {
      return [];
    }
  };
  const mx = async (name: string) => {
    try {
      return await r.resolveMx(name);
    } catch {
      return [];
    }
  };
  const simple = async <T>(fn: () => Promise<T>, label: string, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code && code !== "ENODATA" && code !== "ENOTFOUND") {
        errors.push(`${label}: ${code}`);
      }
      return fallback;
    }
  };

  // Fan out every lookup in parallel.
  const [a, aaaa, ns, mxRecs, soa, caa, txtRoot, dmarcTxt, sendTxt, sendMx, mtaSts, tlsRpt, bimi] =
    await Promise.all([
      simple(() => r.resolve4(domain), "A", [] as string[]),
      simple(() => r.resolve6(domain), "AAAA", [] as string[]),
      simple(() => r.resolveNs(domain), "NS", [] as string[]),
      mx(domain),
      simple(
        async () => (await r.resolveSoa(domain)) as unknown as Record<string, unknown>,
        "SOA",
        null as Record<string, unknown> | null,
      ),
      simple(
        async () => (await r.resolveCaa(domain)) as unknown as Array<Record<string, unknown>>,
        "CAA",
        [] as Array<Record<string, unknown>>,
      ),
      txt(domain),
      txt(`_dmarc.${domain}`),
      txt(`send.${domain}`),
      mx(`send.${domain}`),
      txt(`_mta-sts.${domain}`),
      txt(`_smtp._tls.${domain}`),
      txt(`default._bimi.${domain}`),
    ]);

  // DKIM: probe known selectors in parallel, keep the ones that resolve.
  const dkimResults = await Promise.all(
    DKIM_SELECTORS.map(async (selector) => {
      const recs = await txt(`${selector}._domainkey.${domain}`);
      const value = recs.find((v) => /(^|;)\s*(v=DKIM1|p=)/i.test(v) || /forward-email-dkim/i.test(v));
      return value ? { selector, value } : null;
    }),
  );

  // CNAME — apex is almost always absent (a CNAME at the zone apex is illegal),
  // but www is frequently a CNAME to the host/CDN. Probe both.
  const cnameAt = async (name: string): Promise<Array<{ name: string; target: string }>> => {
    try {
      return (await r.resolveCname(name)).map((target) => ({ name, target }));
    } catch {
      return [];
    }
  };

  // SRV — probe the well-known service labels in parallel.
  const srvResults = await Promise.all(
    SRV_SERVICES.map(async (service) => {
      try {
        const records = (await r.resolveSrv(`${service}.${domain}`)) as SrvRecord[];
        return records.length ? { service, records } : null;
      } catch {
        return null;
      }
    }),
  );

  // DNSSEC (DS/DNSKEY) and service-binding records (HTTPS/SVCB) — node:dns can't
  // query these rrtypes, so they go over DoH.
  const [cnameApex, cnameWww, ds, dnskey, httpsApex, httpsWww, svcb] = await Promise.all([
    cnameAt(domain),
    cnameAt(`www.${domain}`),
    dohData(domain, "DS", 43),
    dohData(domain, "DNSKEY", 48),
    dohData(domain, "HTTPS", 65),
    dohData(`www.${domain}`, "HTTPS", 65),
    dohData(domain, "SVCB", 64),
  ]);

  return {
    domain,
    a,
    aaaa,
    ns,
    mx: mxRecs,
    soa,
    caa,
    txtRoot,
    spf: txtRoot.find((v) => /^v=spf1\b/i.test(v)) ?? null,
    dmarc: dmarcTxt.find((v) => /^v=DMARC1\b/i.test(v)) ?? null,
    dkim: dkimResults.filter((x): x is { selector: string; value: string } => x !== null),
    sendSubdomain: {
      spf: sendTxt.find((v) => /^v=spf1\b/i.test(v)) ?? null,
      mx: sendMx,
    },
    mtaSts,
    tlsRpt,
    bimi,
    cname: [...cnameApex, ...cnameWww],
    srv: srvResults.filter((x): x is { service: string; records: SrvRecord[] } => x !== null),
    dnssec: { ds, dnskey, signed: ds.length > 0 || dnskey.length > 0 },
    https: [...httpsApex, ...httpsWww],
    svcb,
    errors,
  };
}

/**
 * Deterministic baseline findings — independent of the AI step. Covers the
 * high-signal email-auth gaps (SPF / DMARC) that are unambiguous regardless of
 * provider, plus an inventory finding so the report always shows what resolved.
 */
export function dnsBaselineFindings(rec: DnsRecords): Finding[] {
  const out: Finding[] = [];
  const usesForwardEmail = rec.mx.some((m) =>
    /forwardemail\.net$/i.test(m.exchange.replace(/\.$/, "")),
  );

  // Inventory — always a pass; gives the report the raw footprint.
  out.push({
    section: "DNS",
    check_key: "dns.inventory",
    status: rec.a.length || rec.mx.length || rec.ns.length ? "pass" : "fail",
    title: `Resolved DNS footprint for ${rec.domain}`,
    detail: [
      `A: ${rec.a.join(", ") || "—"}`,
      `AAAA: ${rec.aaaa.join(", ") || "—"}`,
      `CNAME: ${rec.cname.map((c) => `${c.name} → ${c.target}`).join(", ") || "—"}`,
      `MX: ${rec.mx.map((m) => `${m.priority} ${m.exchange}`).join(", ") || "—"}`,
      `NS: ${rec.ns.join(", ") || "—"}`,
      `SRV: ${rec.srv.map((s) => s.service).join(", ") || "—"}`,
      `DNSSEC: ${rec.dnssec.signed ? `signed (${rec.dnssec.dnskey.length} DNSKEY, ${rec.dnssec.ds.length} DS)` : "unsigned"}`,
      `HTTPS/SVCB: ${[...rec.https, ...rec.svcb].join(" | ") || "—"}`,
      `DKIM selectors found: ${rec.dkim.map((d) => d.selector).join(", ") || "none"}`,
    ].join("\n"),
    evidence: { ...rec },
    priority: 5,
  });

  // SPF.
  if (!rec.spf) {
    out.push({
      section: "DNS",
      check_key: "dns.spf_missing",
      status: "fail",
      title: "No SPF record on the root domain",
      detail:
        `Mail using @${rec.domain} as envelope-from is unauthenticated and the domain is easy to spoof. ` +
        `Add a TXT record at @: "${
          usesForwardEmail ? "v=spf1 include:spf.forwardemail.net -all" : "v=spf1 -all"
        }".`,
      evidence: { txtRoot: rec.txtRoot },
      priority: 1,
    });
  } else {
    const all = (rec.spf.match(/[~+\-?]all/i) || [])[0] || "(none)";
    const weak = all === "+all" || all === "(none)";
    out.push({
      section: "DNS",
      check_key: "dns.spf",
      status: weak ? "warn" : "pass",
      title: weak ? "SPF present but not enforcing" : "SPF record present",
      detail: weak
        ? `"${rec.spf}" — tighten the terminal mechanism to -all so spoofed senders are rejected.`
        : `"${rec.spf}"`,
      evidence: { spf: rec.spf },
      priority: weak ? 2 : 5,
    });
  }

  // DMARC.
  if (!rec.dmarc) {
    out.push({
      section: "DNS",
      check_key: "dns.dmarc_missing",
      status: "fail",
      title: "No DMARC record",
      detail:
        `Add a TXT record at _dmarc: "v=DMARC1; p=none; rua=mailto:dmarc@${rec.domain}; fo=1; adkim=s; aspf=s" ` +
        `to start collecting reports, then escalate p=none → quarantine → reject.`,
      evidence: {},
      priority: 1,
    });
  } else {
    const p = (rec.dmarc.match(/\bp=([a-z]+)/i) || [])[1] || "(none)";
    const hasRua = /\brua=/i.test(rec.dmarc);
    const weak = p === "none" || !hasRua;
    out.push({
      section: "DNS",
      check_key: "dns.dmarc",
      status: weak ? "warn" : "pass",
      title: weak ? "DMARC present but not enforcing / not reporting" : "DMARC enforcing",
      detail: `"${rec.dmarc}"${
        weak
          ? ` — ${p === "none" ? "p=none does not block spoofing; " : ""}${
              hasRua ? "" : "no rua= so no aggregate reports are collected; "
            }add reporting and escalate toward quarantine/reject.`
          : ""
      }`,
      evidence: { dmarc: rec.dmarc },
      priority: weak ? 2 : 5,
    });
  }

  return out;
}
