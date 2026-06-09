// dig/delv-based DNS collection for the Posture engine. Uses the BIND tools
// (actively maintained by ISC) rather than a JS resolver so we get parsed
// presentation-format output, real DNSSEC validation (AD flag + delv chain
// validation) and DANE/TLSA — none of which node:dns can do.
//
// All lookups go through a validating public resolver (1.1.1.1) so the AD flag
// is meaningful. Every dynamic argument is a hostname/label already validated
// in exec.ts; nothing reaches a shell.

import { run, validDaneLabel, validHost } from "./exec";

const RESOLVER = "@1.1.1.1";

// Well-known SRV service labels worth probing (SRV can't be enumerated).
const SRV_SERVICES = [
  "_sip._tls",
  "_sips._tcp",
  "_xmpp-server._tcp",
  "_xmpp-client._tcp",
  "_autodiscover._tcp",
  "_caldavs._tcp",
  "_carddavs._tcp",
  "_submission._tcp",
  "_imaps._tcp",
  "_pop3s._tcp",
  "_matrix._tcp",
  "_minecraft._tcp",
];

export type PostureDns = {
  domain: string;
  a: string[];
  aaaa: string[];
  cname: string[];
  mx: Array<{ priority: number; exchange: string }>;
  ns: string[];
  soa: string | null;
  caa: string[];
  txt: string[];
  srv: Array<{ service: string; value: string }>;
  https: string[];
  svcb: string[];
  dnssec: {
    dsAtParent: string[];
    dnskey: string[];
    adFlag: boolean;
    delvValidated: boolean | null; // null = delv unavailable
  };
  daneWeb: string[];
  daneMail: Array<{ host: string; tlsa: string[] }>;
  toolMissing: boolean;
};

function lines(s: string): string[] {
  return s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** `dig +short <name> <type>` → array of answer lines. */
async function digShort(name: string, type: string): Promise<string[]> {
  const res = await run("dig", [RESOLVER, "+short", name, type]);
  if (!res.ok) return [];
  // Strip only a single trailing root dot from hostname answers (MX/NS/CNAME).
  // Quoted values (CAA/TXT/HTTPS/SVCB) are left intact for fidelity.
  return lines(res.stdout).map((l) => (/"/.test(l) ? l : l.replace(/\.$/, "")));
}

/** Returns true if a validating resolver set the AD (Authenticated Data) flag. */
async function hasAdFlag(name: string): Promise<boolean> {
  const res = await run("dig", [RESOLVER, "+dnssec", "+noall", "+comments", name, "SOA"]);
  if (!res.ok) return false;
  const flagLine = lines(res.stdout).find((l) => l.startsWith(";; flags:"));
  return !!flagLine && /\bad\b/.test(flagLine);
}

/** delv chain validation — "fully validated" means the DNSSEC chain checks out. */
async function delvValidated(domain: string): Promise<boolean | null> {
  const res = await run("delv", [RESOLVER, domain, "A"]);
  if (!res.ok) return res.error.includes("not installed") ? null : false;
  return /fully validated/i.test(res.stdout);
}

export async function collectPostureDns(domain: string): Promise<PostureDns> {
  if (!validHost(domain)) {
    throw new Error(`Posture: "${domain}" is not a valid domain.`);
  }

  const [a, aaaa, cnameRaw, mxRaw, ns, soaRaw, caa, txt, dsRaw, dnskeyRaw, httpsRaw, svcbRaw] =
    await Promise.all([
      digShort(domain, "A"),
      digShort(domain, "AAAA"),
      digShort(`www.${domain}`, "CNAME"),
      digShort(domain, "MX"),
      digShort(domain, "NS"),
      digShort(domain, "SOA"),
      digShort(domain, "CAA"),
      digShort(domain, "TXT"),
      digShort(domain, "DS"),
      digShort(domain, "DNSKEY"),
      digShort(domain, "HTTPS"),
      digShort(domain, "SVCB"),
    ]);

  const mx = mxRaw
    .map((l) => {
      const m = l.match(/^(\d+)\s+(.+)$/);
      return m ? { priority: Number(m[1]), exchange: m[2] } : null;
    })
    .filter((x): x is { priority: number; exchange: string } => x !== null)
    .sort((p, q) => p.priority - q.priority);

  // SRV probes — fan out, keep ones that resolve.
  const srvResults = await Promise.all(
    SRV_SERVICES.map(async (service) => {
      const label = `${service}.${domain}`;
      if (!validDaneLabel(label)) return [];
      const vals = await digShort(label, "SRV");
      return vals.map((value) => ({ service, value }));
    }),
  );

  // DANE/TLSA: web on _443._tcp, mail on _25._tcp.<each MX exchange>.
  const webLabel = `_443._tcp.${domain}`;
  const [daneWeb, adFlag, delvOk, daneMail] = await Promise.all([
    validDaneLabel(webLabel) ? digShort(webLabel, "TLSA") : Promise.resolve([]),
    hasAdFlag(domain),
    delvValidated(domain),
    Promise.all(
      mx.map(async (m) => {
        const label = `_25._tcp.${m.exchange}`;
        if (!validHost(m.exchange) || !validDaneLabel(label)) return { host: m.exchange, tlsa: [] };
        return { host: m.exchange, tlsa: await digShort(label, "TLSA") };
      }),
    ),
  ]);

  // If dig itself is missing every lookup comes back empty — flag it so the
  // engine can surface a clear "tool unavailable" finding instead of a blank.
  const probe = await run("dig", ["-v"]);
  const toolMissing = !probe.ok && probe.error.includes("not installed");

  return {
    domain,
    a,
    aaaa,
    cname: cnameRaw,
    mx,
    ns,
    soa: soaRaw[0] ?? null,
    caa,
    txt,
    srv: srvResults.flat(),
    https: httpsRaw,
    svcb: svcbRaw,
    dnssec: {
      dsAtParent: dsRaw,
      dnskey: dnskeyRaw,
      adFlag,
      delvValidated: delvOk,
    },
    daneWeb,
    daneMail: daneMail.filter((d) => d.tlsa.length > 0),
    toolMissing,
  };
}
