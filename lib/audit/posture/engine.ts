// The "Posture" engine — a Hardenize-style domain security report. It does NOT
// crawl the site; it deterministically inspects the domain's infrastructure
// using maintained server CLI tools (dig/delv for DNS/DNSSEC/DANE, openssl for
// TLS/certificate) plus the existing email-auth collector, then grades each
// category A–F and rolls them into an overall score.
//
// Returns the standard { score, findings, summary, markdown } engine shape so
// it rides the worker's normal dispatch + rendering path.

import { collectDnsRecords, domainFromTarget } from "../dns";
import { scoreFindings } from "../score";
import type { ClaudeAuditResult } from "../claude-engine";
import type { Finding } from "../types";
import { collectPostureDns, type PostureDns } from "./dns";
import { collectPostureTls, type PostureCert, type PostureTls } from "./tls";
import { gradeCategory, gradeScore, gradeStatus, letterFromScore } from "./grade";

const SEC = {
  summary: "Posture Summary",
  dns: "DNS",
  dnssec: "DNSSEC",
  email: "Email Authentication",
  tls: "TLS",
  cert: "Certificate",
  web: "Web Security",
} as const;

type P = Finding["priority"];

function hostFromTarget(targetUrl: string, fallback: string): string {
  try {
    return new URL(/^https?:\/\//i.test(targetUrl) ? targetUrl : `https://${targetUrl}`).hostname;
  } catch {
    return fallback;
  }
}

// ---- category finding builders ---------------------------------------------

function dnsFindings(d: PostureDns): Finding[] {
  if (d.toolMissing) {
    return [{
      section: SEC.dns,
      check_key: "posture.dns.tool",
      status: "unknown",
      title: "DNS tooling unavailable",
      detail: "The `dig` resolver is not installed in this environment, so DNS could not be inspected.",
      priority: 2,
    }];
  }
  const out: Finding[] = [];
  out.push({
    section: SEC.dns,
    check_key: "posture.dns.inventory",
    status: d.a.length || d.mx.length || d.ns.length ? "pass" : "fail",
    title: `Resolved DNS footprint for ${d.domain}`,
    detail: [
      `A: ${d.a.join(", ") || "—"}`,
      `AAAA: ${d.aaaa.join(", ") || "—"}`,
      `CNAME (www): ${d.cname.join(", ") || "—"}`,
      `MX: ${d.mx.map((m) => `${m.priority} ${m.exchange}`).join(", ") || "—"}`,
      `NS: ${d.ns.join(", ") || "—"}`,
      `SOA: ${d.soa ?? "—"}`,
      `CAA: ${d.caa.join(" | ") || "—"}`,
      `SRV: ${d.srv.map((s) => `${s.service} ${s.value}`).join(" | ") || "—"}`,
      `HTTPS/SVCB: ${[...d.https, ...d.svcb].join(" | ") || "—"}`,
      `TXT: ${d.txt.join(" | ") || "—"}`,
    ].join("\n"),
    evidence: { ...d },
    priority: 5,
  });

  out.push({
    section: SEC.dns,
    check_key: "posture.dns.ns",
    status: d.ns.length >= 2 ? "pass" : d.ns.length === 1 ? "warn" : "fail",
    title:
      d.ns.length >= 2
        ? `${d.ns.length} nameservers`
        : d.ns.length === 1
          ? "Only one nameserver"
          : "No nameservers resolved",
    detail: d.ns.length >= 2 ? undefined : "RFC 2182 recommends at least two nameservers on diverse networks for redundancy.",
    priority: d.ns.length >= 2 ? 5 : 3,
  });

  out.push({
    section: SEC.dns,
    check_key: "posture.dns.caa",
    status: d.caa.length > 0 ? "pass" : "warn",
    title: d.caa.length > 0 ? "CAA policy present" : "No CAA record",
    detail:
      d.caa.length > 0
        ? undefined
        : "Add a CAA record to restrict which CAs may issue certificates for this domain (e.g. `0 issue \"letsencrypt.org\"`).",
    priority: d.caa.length > 0 ? 5 : 3,
  });
  return out;
}

function dnssecFindings(d: PostureDns): Finding[] {
  const signed = d.dnssec.dnskey.length > 0 || d.dnssec.dsAtParent.length > 0;
  const validated = d.dnssec.adFlag || d.dnssec.delvValidated === true;
  if (signed && validated) {
    return [{
      section: SEC.dnssec,
      check_key: "posture.dnssec",
      status: "pass",
      title: "DNSSEC signed and validating",
      detail: `${d.dnssec.dnskey.length} DNSKEY, ${d.dnssec.dsAtParent.length} DS at parent; chain validates (AD flag${d.dnssec.delvValidated ? " + delv" : ""}).`,
      priority: 5,
    }];
  }
  if (signed && !validated) {
    return [{
      section: SEC.dnssec,
      check_key: "posture.dnssec",
      status: "warn",
      title: "DNSSEC present but not validating",
      detail: "DNSKEY/DS records exist but the chain did not validate (missing or mismatched DS at the parent). Fix the chain of trust at your registrar.",
      priority: 2,
    }];
  }
  return [{
    section: SEC.dnssec,
    check_key: "posture.dnssec",
    status: "warn",
    title: "DNSSEC not deployed",
    detail: "The zone is unsigned, so resolvers cannot detect forged DNS answers. Enable DNSSEC at your DNS host and publish the DS record at your registrar.",
    priority: 3,
  }];
}

function emailFindings(email: Awaited<ReturnType<typeof collectDnsRecords>>, d: PostureDns): Finding[] {
  const out: Finding[] = [];
  const dom = d.domain;

  // SPF
  if (!email.spf) {
    out.push({ section: SEC.email, check_key: "posture.email.spf", status: "fail", title: "No SPF record", detail: `Mail using @${dom} is unauthenticated and easy to spoof. Add a TXT record at the apex: "v=spf1 -all" (or include your provider).`, priority: 1 });
  } else {
    const all = (email.spf.match(/[~+\-?]all/i) || [])[0] || "(none)";
    const weak = all === "+all" || all === "(none)";
    out.push({ section: SEC.email, check_key: "posture.email.spf", status: weak ? "warn" : "pass", title: weak ? "SPF present but not enforcing" : "SPF enforcing", detail: weak ? `"${email.spf}" — end with -all so spoofed senders are rejected.` : `"${email.spf}"`, priority: weak ? 2 : 5 });
  }

  // DMARC
  if (!email.dmarc) {
    out.push({ section: SEC.email, check_key: "posture.email.dmarc", status: "fail", title: "No DMARC record", detail: `Add a TXT record at _dmarc.${dom}: "v=DMARC1; p=none; rua=mailto:dmarc@${dom}" then escalate to quarantine/reject.`, priority: 1 });
  } else {
    const p = (email.dmarc.match(/\bp=([a-z]+)/i) || [])[1] || "(none)";
    const hasRua = /\brua=/i.test(email.dmarc);
    const weak = p === "none" || !hasRua;
    out.push({ section: SEC.email, check_key: "posture.email.dmarc", status: weak ? "warn" : "pass", title: weak ? "DMARC present but not enforcing/reporting" : "DMARC enforcing", detail: `"${email.dmarc}"`, priority: weak ? 2 : 5 });
  }

  // DKIM
  out.push({
    section: SEC.email,
    check_key: "posture.email.dkim",
    status: email.dkim.length > 0 ? "pass" : "warn",
    title: email.dkim.length > 0 ? `DKIM selectors found: ${email.dkim.map((k) => k.selector).join(", ")}` : "No common DKIM selectors resolved",
    detail: email.dkim.length > 0 ? undefined : "None of the common selectors resolved — your provider may use a custom selector (not necessarily a problem).",
    priority: email.dkim.length > 0 ? 5 : 3,
  });

  // MTA-STS + TLS-RPT
  out.push({ section: SEC.email, check_key: "posture.email.mtasts", status: email.mtaSts.length > 0 ? "pass" : "warn", title: email.mtaSts.length > 0 ? "MTA-STS policy present" : "No MTA-STS policy", detail: email.mtaSts.length > 0 ? undefined : "Publish an MTA-STS policy to enforce TLS on inbound mail and resist downgrade attacks.", priority: email.mtaSts.length > 0 ? 5 : 4 });
  out.push({ section: SEC.email, check_key: "posture.email.tlsrpt", status: email.tlsRpt.length > 0 ? "pass" : "warn", title: email.tlsRpt.length > 0 ? "TLS-RPT reporting enabled" : "No TLS-RPT reporting", detail: email.tlsRpt.length > 0 ? undefined : "Add a _smtp._tls TXT record to receive reports on inbound TLS failures.", priority: email.tlsRpt.length > 0 ? 5 : 4 });

  // DANE / TLSA for mail (advanced — informational when absent).
  if (d.daneMail.length > 0) {
    out.push({ section: SEC.email, check_key: "posture.email.dane", status: "pass", title: "DANE/TLSA published for mail", detail: d.daneMail.map((m) => `${m.host}: ${m.tlsa.length} TLSA record(s)`).join("\n"), priority: 5 });
  } else if (d.mx.length > 0) {
    out.push({ section: SEC.email, check_key: "posture.email.dane", status: "warn", title: "No DANE/TLSA for mail", detail: "DANE binds your mail TLS cert to DNSSEC. Optional, but a strong anti-downgrade signal once DNSSEC is in place.", priority: 5 });
  }

  // BIMI (informational, present only).
  if (email.bimi.length > 0) {
    out.push({ section: SEC.email, check_key: "posture.email.bimi", status: "pass", title: "BIMI record present", priority: 5 });
  }
  return out;
}

function tlsFindings(t: PostureTls): Finding[] {
  if (t.toolMissing) {
    return [{ section: SEC.tls, check_key: "posture.tls.tool", status: "unknown", title: "TLS tooling unavailable", detail: "`openssl` is not installed, so TLS could not be inspected.", priority: 2 }];
  }
  if (!t.reachable) {
    return [{ section: SEC.tls, check_key: "posture.tls.reachable", status: "fail", title: "No TLS service on port 443", detail: "The host did not complete a TLS handshake on :443.", priority: 1 }];
  }
  const out: Finding[] = [];
  const legacy = t.protocols["TLSv1.0"] || t.protocols["TLSv1.1"];
  out.push({
    section: SEC.tls,
    check_key: "posture.tls.legacy",
    status: legacy ? "fail" : "pass",
    title: legacy ? "Legacy TLS (1.0/1.1) enabled" : "No legacy TLS",
    detail: legacy
      ? `Disable TLS 1.0/1.1 — they are deprecated (RFC 8996). Enabled: ${(["TLSv1.0", "TLSv1.1"] as const).filter((k) => t.protocols[k]).join(", ")}.`
      : undefined,
    priority: legacy ? 2 : 5,
  });
  out.push({ section: SEC.tls, check_key: "posture.tls.tls12", status: t.protocols["TLSv1.2"] ? "pass" : "warn", title: t.protocols["TLSv1.2"] ? "TLS 1.2 supported" : "TLS 1.2 not supported", priority: t.protocols["TLSv1.2"] ? 5 : 3 });
  out.push({ section: SEC.tls, check_key: "posture.tls.tls13", status: t.protocols["TLSv1.3"] ? "pass" : "warn", title: t.protocols["TLSv1.3"] ? "TLS 1.3 supported" : "TLS 1.3 not enabled", detail: t.protocols["TLSv1.3"] ? undefined : "Enable TLS 1.3 for the strongest, fastest handshakes.", priority: t.protocols["TLSv1.3"] ? 5 : 4 });
  out.push({ section: SEC.tls, check_key: "posture.tls.negotiated", status: "pass", title: `Negotiated ${t.negotiatedProtocol ?? "?"} / ${t.negotiatedCipher ?? "?"}`, priority: 5 });
  return out;
}

function certFindings(cert: PostureCert | null): Finding[] {
  if (!cert) return [];
  const out: Finding[] = [];
  // Expiry
  if (cert.expired) {
    out.push({ section: SEC.cert, check_key: "posture.cert.expiry", status: "fail", title: "Certificate expired or not yet valid", detail: `notBefore=${cert.notBefore} notAfter=${cert.notAfter}`, priority: 1 });
  } else if (cert.daysToExpiry !== null && cert.daysToExpiry < 14) {
    out.push({ section: SEC.cert, check_key: "posture.cert.expiry", status: "warn", title: `Certificate expires in ${cert.daysToExpiry} days`, detail: "Renew soon to avoid an outage — automate renewal if possible.", priority: 2 });
  } else {
    out.push({ section: SEC.cert, check_key: "posture.cert.expiry", status: "pass", title: cert.daysToExpiry !== null ? `Certificate valid for ${cert.daysToExpiry} more days` : "Certificate valid", detail: `Issuer: ${cert.issuer ?? "?"}`, priority: 5 });
  }
  // Self-signed / chain
  if (cert.selfSigned) {
    out.push({ section: SEC.cert, check_key: "posture.cert.selfsigned", status: "fail", title: "Self-signed certificate", detail: "Browsers will reject this. Use a CA-issued certificate (e.g. Let's Encrypt).", priority: 1 });
  }
  // Key strength
  if (cert.keyBits !== null) {
    const isRsa = /RSA|sha\d+WithRSA/i.test(cert.signatureAlgorithm ?? "") || cert.keyBits >= 2048;
    const weak = (isRsa && cert.keyBits < 2048) || (!isRsa && cert.keyBits < 256);
    out.push({ section: SEC.cert, check_key: "posture.cert.key", status: weak ? "fail" : "pass", title: weak ? `Weak key (${cert.keyBits}-bit)` : `${cert.keyBits}-bit key`, detail: weak ? "Use a 2048-bit+ RSA or 256-bit+ ECDSA key." : undefined, priority: weak ? 2 : 5 });
  }
  // Signature algorithm
  if (cert.signatureAlgorithm) {
    const sha1 = /sha1|md5/i.test(cert.signatureAlgorithm);
    out.push({ section: SEC.cert, check_key: "posture.cert.sigalg", status: sha1 ? "fail" : "pass", title: `Signature: ${cert.signatureAlgorithm}`, detail: sha1 ? "SHA-1/MD5 signatures are broken; reissue with SHA-256+." : undefined, priority: sha1 ? 1 : 5 });
  }
  // SAN inventory
  out.push({ section: SEC.cert, check_key: "posture.cert.san", status: cert.san.length > 0 ? "pass" : "warn", title: cert.san.length > 0 ? `Covers ${cert.san.length} name(s)` : "No SAN entries", detail: cert.san.length > 0 ? cert.san.slice(0, 12).join(", ") : undefined, priority: 5 });
  return out;
}

function webFindings(t: PostureTls): Finding[] {
  if (t.toolMissing || !t.reachable) return [];
  const out: Finding[] = [];
  out.push({
    section: SEC.web,
    check_key: "posture.web.hsts",
    status: t.hsts ? "pass" : "warn",
    title: t.hsts ? "HSTS enabled" : "No HSTS",
    detail: t.hsts ? t.hsts : "Add `Strict-Transport-Security: max-age=31536000; includeSubDomains` to force HTTPS.",
    priority: t.hsts ? 5 : 3,
  });
  if (t.httpsRedirect !== null) {
    out.push({
      section: SEC.web,
      check_key: "posture.web.redirect",
      status: t.httpsRedirect ? "pass" : "warn",
      title: t.httpsRedirect ? "HTTP redirects to HTTPS" : "HTTP does not redirect to HTTPS",
      detail: t.httpsRedirect ? undefined : "Redirect all http:// traffic to https:// at the edge.",
      priority: t.httpsRedirect ? 5 : 2,
    });
  }
  return out;
}

// ---- orchestration ----------------------------------------------------------

function statusEmoji(s: Finding["status"]) {
  return s === "pass" ? "✅" : s === "warn" ? "⚠️" : s === "fail" ? "❌" : "❓";
}

function buildMarkdown(domain: string, overall: number, categories: Array<{ name: string; grade: string; score: number; findings: Finding[] }>): string {
  const lines: string[] = [
    `# Security Posture — ${domain}`,
    "",
    `**Overall:** ${letterFromScore(overall)} (${overall}/100)  `,
    `**Generated:** ${new Date().toISOString()}`,
    "",
    "| Category | Grade |",
    "|---|:--:|",
    ...categories.map((c) => `| ${c.name} | ${c.grade} |`),
    "",
  ];
  for (const c of categories) {
    lines.push(`## ${c.name} — ${c.grade}`, "");
    for (const f of c.findings.filter((x) => !x.check_key.endsWith(".inventory")).sort((a, b) => a.priority - b.priority)) {
      lines.push(`- ${statusEmoji(f.status)} **${f.title}**${f.detail ? `\n  ${f.detail.split("\n").join("\n  ")}` : ""}`);
    }
    const inv = c.findings.find((x) => x.check_key.endsWith(".inventory"));
    if (inv?.detail) lines.push("", "```", inv.detail, "```");
    lines.push("");
  }
  lines.push("---", "_Report by [CrawlProof](https://crawlproof.com)._");
  return lines.join("\n");
}

export async function postureAudit(targetUrl: string): Promise<ClaudeAuditResult> {
  const started = Date.now();
  const domain = domainFromTarget(targetUrl);
  if (!domain) throw new Error(`Posture: "${targetUrl}" is not a valid domain.`);
  const host = hostFromTarget(targetUrl, domain);

  const [dns, tls, email] = await Promise.all([
    collectPostureDns(domain),
    collectPostureTls(host),
    collectDnsRecords(domain).catch(() => null),
  ]);

  const cats = [
    { name: SEC.dns, findings: dnsFindings(dns) },
    { name: SEC.dnssec, findings: dnssecFindings(dns) },
    { name: SEC.email, findings: email ? emailFindings(email, dns) : [] },
    { name: SEC.tls, findings: tlsFindings(tls) },
    { name: SEC.cert, findings: certFindings(tls.cert) },
    { name: SEC.web, findings: webFindings(tls) },
  ].filter((c) => c.findings.length > 0);

  // Grade each category and build the summary grid (rendered first).
  const graded = cats.map((c) => {
    const { grade } = gradeCategory(c.findings);
    return { ...c, grade, score: gradeScore(grade) };
  });

  const summaryFindings: Finding[] = graded.map((c) => ({
    section: SEC.summary,
    check_key: `posture.summary.${c.name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
    status: gradeStatus(c.grade),
    title: `${c.name}: Grade ${c.grade}`,
    priority: 5,
  }));

  const findings: Finding[] = [...summaryFindings, ...graded.flatMap((c) => c.findings)];

  // Overall score: even average of each category's grade band.
  const overall = graded.length > 0 ? Math.round(graded.reduce((s, c) => s + c.score, 0) / graded.length) : scoreFindings(findings);

  const markdown = buildMarkdown(domain, overall, graded);

  return {
    score: overall,
    findings,
    summary: {
      pagesCrawled: 0,
      pass: findings.filter((f) => f.status === "pass").length,
      warn: findings.filter((f) => f.status === "warn").length,
      fail: findings.filter((f) => f.status === "fail").length,
      unknown: findings.filter((f) => f.status === "unknown").length,
      dataFound: [],
      durationMs: Date.now() - started,
    },
    markdown,
  };
}
