import { describe, expect, it } from "vitest";
import {
  dnsBaselineFindings,
  domainFromTarget,
  type DnsRecords,
} from "@/lib/audit/dns";

function records(overrides: Partial<DnsRecords> = {}): DnsRecords {
  return {
    domain: "example.com",
    a: ["93.184.216.34"],
    aaaa: [],
    ns: ["a.iana-servers.net", "b.iana-servers.net"],
    mx: [{ priority: 10, exchange: "mx.example.com" }],
    soa: null,
    caa: [],
    txtRoot: [],
    spf: null,
    dmarc: null,
    dkim: [],
    sendSubdomain: { spf: null, mx: [] },
    mtaSts: [],
    tlsRpt: [],
    bimi: [],
    cname: [],
    srv: [],
    dnssec: { ds: [], dnskey: [], signed: false },
    https: [],
    svcb: [],
    errors: [],
    ...overrides,
  };
}

describe("domainFromTarget", () => {
  it("normalizes URLs to the DNS hostname and drops www", () => {
    expect(domainFromTarget("https://www.Example.com/path?q=1")).toBe("example.com");
  });

  it("accepts bare hostnames", () => {
    expect(domainFromTarget("example.com")).toBe("example.com");
  });

  it("rejects invalid or single-label hostnames", () => {
    expect(domainFromTarget("localhost")).toBeNull();
    expect(domainFromTarget("https://bad host.example")).toBeNull();
  });
});

describe("dnsBaselineFindings", () => {
  it("flags missing SPF and DMARC as fail-level issues", () => {
    const findings = dnsBaselineFindings(records());

    expect(findings.find((f) => f.check_key === "dns.inventory")?.status).toBe("pass");
    expect(findings.find((f) => f.check_key === "dns.spf_missing")?.status).toBe("fail");
    expect(findings.find((f) => f.check_key === "dns.dmarc_missing")?.status).toBe("fail");
  });

  it("passes enforcing SPF and DMARC records", () => {
    const findings = dnsBaselineFindings(
      records({
        txtRoot: ["v=spf1 include:_spf.example.com -all"],
        spf: "v=spf1 include:_spf.example.com -all",
        dmarc: "v=DMARC1; p=reject; rua=mailto:dmarc@example.com; adkim=s; aspf=s",
      }),
    );

    expect(findings.find((f) => f.check_key === "dns.spf")?.status).toBe("pass");
    expect(findings.find((f) => f.check_key === "dns.dmarc")?.status).toBe("pass");
  });

  it("warns on weak SPF or monitor-only DMARC", () => {
    const findings = dnsBaselineFindings(
      records({
        txtRoot: ["v=spf1 +all"],
        spf: "v=spf1 +all",
        dmarc: "v=DMARC1; p=none",
      }),
    );

    expect(findings.find((f) => f.check_key === "dns.spf")?.status).toBe("warn");
    expect(findings.find((f) => f.check_key === "dns.dmarc")?.status).toBe("warn");
  });
});
