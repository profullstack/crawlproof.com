// Email DNS auditor. Checks SPF / DKIM / DMARC / MX and related records for
// one or more domains and flags what's missing, weak, or harmful. Uses the
// built-in node:dns resolver (no shell, no external deps) so there is zero
// command-injection surface; input is still validated against a strict
// hostname pattern as defense-in-depth.
//
//   node scripts/dns-email-audit.mjs crawlproof.com saasrow.com
//   node scripts/dns-email-audit.mjs            # defaults to DOMAINS below
//
// Assumptions baked into the advice: outbound via Resend (resend._domainkey +
// a `send.` bounce subdomain) and inbound/SMTP via ForwardEmail.

import { Resolver } from "node:dns/promises";

const DEFAULT_DOMAINS = ["crawlproof.com", "saasrow.com"];

// Use public resolvers and bypass any local/stale caching.
const resolver = new Resolver();
resolver.setServers(["1.1.1.1", "8.8.8.8"]);

// RFC 1123 hostname: labels of [a-z0-9-], no leading/trailing hyphen, <=253
// chars total, <=63 per label. Reject anything else before it touches DNS.
const HOSTNAME_RE =
  /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i;

function sanitizeDomain(input) {
  if (typeof input !== "string") return null;
  // Strip scheme, path, port, surrounding whitespace and a trailing dot.
  let d = input.trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, "").replace(/[/:].*$/, "").replace(/\.$/, "");
  if (!HOSTNAME_RE.test(d)) return null;
  return d;
}

// ---- color / glyph helpers ----------------------------------------------
const useColor = process.stdout.isTTY;
const c = (n, s) => (useColor ? `\x1b[${n}m${s}\x1b[0m` : s);
const dim = (s) => c("2", s);
const bold = (s) => c("1", s);
const PASS = c("32", "PASS");
const WARN = c("33", "WARN");
const FAIL = c("31", "FAIL");
const INFO = c("36", "INFO");

const findings = []; // { domain, level, label, detail }
function record(domain, level, label, detail) {
  findings.push({ domain, level, label, detail });
  const tag = { PASS, WARN, FAIL, INFO }[level];
  console.log(`  ${tag}  ${bold(label)}${detail ? ` — ${detail}` : ""}`);
}

// Resolve helpers that swallow ENODATA/ENOTFOUND into empty results.
async function txt(name) {
  try {
    // resolveTxt returns string[][]; join the chunks of each record.
    return (await resolver.resolveTxt(name)).map((parts) => parts.join(""));
  } catch {
    return [];
  }
}
async function mx(name) {
  try {
    return await resolver.resolveMx(name);
  } catch {
    return [];
  }
}
async function recs(name, fn) {
  try {
    return await resolver[fn](name);
  } catch {
    return [];
  }
}

async function auditDomain(domain) {
  console.log("\n" + bold(`=== ${domain} ===`));

  // Paste-ready records to add, collected as gaps are found.
  // { priority: "required" | "optional", host, type, value, note }
  const recommendations = [];
  const recommend = (priority, host, type, value, note) =>
    recommendations.push({ priority, host, type, value, note });

  // --- MX -----------------------------------------------------------------
  const mxRecs = await mx(domain);
  const usesForwardEmail = mxRecs.some((m) =>
    /forwardemail\.net$/i.test(m.exchange.replace(/\.$/, ""))
  );
  if (mxRecs.length) {
    record(
      domain,
      "PASS",
      "MX",
      mxRecs.map((m) => `${m.priority} ${m.exchange}`).join(", ")
    );
  } else {
    record(domain, "WARN", "MX", "no MX records — domain cannot receive mail");
  }

  // --- SPF (root TXT) ------------------------------------------------------
  const rootTxt = await txt(domain);
  const spf = rootTxt.find((r) => /^v=spf1\b/i.test(r));
  if (!spf) {
    record(
      domain,
      "FAIL",
      "SPF (root)",
      "no v=spf1 record — outbound mail using @" +
        domain +
        " is unauthenticated and the domain is easy to spoof"
    );
    // ForwardEmail's documented include; if you don't use FE for outbound,
    // swap the include for your real sender (or just publish a hard -all).
    const spfValue = usesForwardEmail
      ? "v=spf1 include:spf.forwardemail.net -all"
      : "v=spf1 -all";
    recommend(
      "required",
      "@",
      "TXT",
      spfValue,
      usesForwardEmail
        ? "Confirm the exact include string in your ForwardEmail dashboard. Resend stays covered by send.<domain> — do NOT add amazonses here."
        : "No outbound sender detected on the root domain; -all blocks spoofing. Add an include: for your real sender if any."
    );
  } else {
    // Rough SPF DNS-lookup budget check (RFC 7208 limit is 10).
    const lookups = (spf.match(/\b(include|a|mx|ptr|exists|redirect)[:=]/gi) || [])
      .length;
    const all = (spf.match(/[~+\-?]all/i) || [])[0] || "(none)";
    const level = all === "-all" || all === "~all" ? "PASS" : "WARN";
    let detail = `"${spf}" — ${lookups} lookup mechanism(s), ends ${all}`;
    if (lookups > 10)
      detail += " ⚠ exceeds RFC 7208 10-lookup limit (PermError)";
    if (all === "+all") detail += " ⚠ +all allows anyone to send as you";
    if (all === "(none)") detail += " ⚠ missing terminal -all/~all";
    record(domain, lookups > 10 || all === "+all" ? "WARN" : level, "SPF (root)", detail);
    if (all === "+all" || all === "(none)") {
      recommend(
        "required",
        "@",
        "TXT",
        spf.replace(/\s*[~+\-?]?all\s*$/i, "").trim() + " -all",
        "Tighten the SPF terminal to -all (hard fail) so spoofed senders are rejected."
      );
    }
  }

  // --- DMARC ---------------------------------------------------------------
  const dmarcTxt = await txt(`_dmarc.${domain}`);
  const dmarc = dmarcTxt.find((r) => /^v=DMARC1\b/i.test(r));
  const dmarcRua = `mailto:dmarc@${domain}`;
  if (!dmarc) {
    record(domain, "FAIL", "DMARC", "no _dmarc record");
    recommend(
      "required",
      "_dmarc",
      "TXT",
      `v=DMARC1; p=none; rua=${dmarcRua}; fo=1; adkim=s; aspf=s`,
      "Start at p=none to collect reports, then escalate p=none → quarantine → reject once legit mail passes."
    );
  } else {
    const p = (dmarc.match(/\bp=([a-z]+)/i) || [])[1] || "(none)";
    const hasRua = /\brua=/i.test(dmarc);
    let level = "PASS";
    const notes = [];
    if (p === "none") {
      level = "WARN";
      notes.push("p=none does not block spoofing (monitor-only)");
    }
    if (!hasRua) {
      level = "WARN";
      notes.push("no rua= — you are not collecting aggregate reports");
    }
    record(
      domain,
      level,
      "DMARC",
      `"${dmarc}"${notes.length ? " — " + notes.join("; ") : ""}`
    );
    if (p === "none" || !hasRua) {
      recommend(
        "required",
        "_dmarc",
        "TXT",
        `v=DMARC1; p=none; rua=${dmarcRua}; fo=1; adkim=s; aspf=s`,
        "Add rua reporting now; once SPF+DKIM align cleanly, move p=none → quarantine → reject."
      );
    }
  }

  // --- DKIM: Resend --------------------------------------------------------
  const resendDkim = await txt(`resend._domainkey.${domain}`);
  if (resendDkim.some((r) => /p=/.test(r))) {
    record(domain, "PASS", "DKIM (resend)", "resend._domainkey present");
  } else {
    record(
      domain,
      "INFO",
      "DKIM (resend)",
      "no resend._domainkey — only matters if you send via Resend"
    );
  }

  // --- Resend bounce/Return-Path subdomain (send.) -------------------------
  const sendSpf = (await txt(`send.${domain}`)).find((r) => /^v=spf1/i.test(r));
  const sendMx = await mx(`send.${domain}`);
  if (sendSpf || sendMx.length) {
    record(
      domain,
      "PASS",
      "Resend send. subdomain",
      `SPF ${sendSpf ? "set" : "missing"}, bounce MX ${
        sendMx.length ? "set" : "missing"
      } — gives Resend SPF alignment`
    );
  } else {
    record(
      domain,
      "INFO",
      "Resend send. subdomain",
      "not configured (newer Resend setup uses send.<domain> for Return-Path)"
    );
  }

  // --- DKIM: ForwardEmail --------------------------------------------------
  const feDkim = await txt(`forwardemail._domainkey.${domain}`);
  if (feDkim.some((r) => /p=|forward-email-dkim/.test(r))) {
    record(domain, "PASS", "DKIM (forwardemail)", "forwardemail._domainkey present");
  } else if (usesForwardEmail) {
    record(
      domain,
      "WARN",
      "DKIM (forwardemail)",
      "missing — required ONLY if you send outbound via ForwardEmail SMTP"
    );
    recommend(
      "optional",
      "forwardemail._domainkey",
      "TXT",
      "<copy DKIM value from ForwardEmail dashboard>",
      "Only needed if you send outbound via ForwardEmail SMTP. The key is generated per-domain — copy it from My Account → Domains → Setup."
    );
  } else {
    record(domain, "INFO", "DKIM (forwardemail)", "not set (n/a unless using FE SMTP)");
  }

  // --- Nice-to-haves -------------------------------------------------------
  const mtaSts = await txt(`_mta-sts.${domain}`);
  record(
    domain,
    mtaSts.length ? "PASS" : "INFO",
    "MTA-STS",
    mtaSts.length ? mtaSts.join(" ") : "absent (optional: enforces inbound TLS)"
  );

  const tlsRpt = await txt(`_smtp._tls.${domain}`);
  record(
    domain,
    tlsRpt.length ? "PASS" : "INFO",
    "TLS-RPT",
    tlsRpt.length ? tlsRpt.join(" ") : "absent (optional: TLS failure reports)"
  );

  const bimi = await txt(`default._bimi.${domain}`);
  record(
    domain,
    bimi.length ? "PASS" : "INFO",
    "BIMI",
    bimi.length ? bimi.join(" ") : "absent (only worth it at DMARC quarantine/reject)"
  );

  const caa = await recs(domain, "resolveCaa");
  record(
    domain,
    caa.length ? "PASS" : "INFO",
    "CAA",
    caa.length
      ? caa.map((r) => JSON.stringify(r)).join(", ")
      : "absent (optional: restrict which CAs may issue certs)"
  );
  if (!caa.length) {
    recommend(
      "optional",
      "@",
      "CAA",
      '0 issue "letsencrypt.org"',
      "Restricts cert issuance to your CA. Match your real issuer (Railway/bolt.new use Let's Encrypt)."
    );
  }

  // --- recommended records to add -----------------------------------------
  if (recommendations.length) {
    console.log("\n  " + bold("Recommended records to add:"));
    const order = { required: 0, optional: 1 };
    recommendations.sort((a, b) => order[a.priority] - order[b.priority]);
    for (const r of recommendations) {
      const badge =
        r.priority === "required" ? c("31", "[required]") : c("33", "[optional]");
      console.log(`    ${badge} ${bold(r.host)}  ${r.type}`);
      console.log(`      value: ${r.value}`);
      if (r.note) console.log(dim(`      note:  ${r.note}`));
    }
  }
  return recommendations;
}

// --- main ------------------------------------------------------------------
const raw = process.argv.slice(2);
const requested = raw.length ? raw : DEFAULT_DOMAINS;

const domains = [];
for (const r of requested) {
  const d = sanitizeDomain(r);
  if (!d) {
    console.error(c("31", `skipping invalid domain: ${JSON.stringify(r)}`));
    continue;
  }
  if (!domains.includes(d)) domains.push(d);
}

if (!domains.length) {
  console.error("no valid domains to audit");
  process.exit(2);
}

console.log(dim(`Auditing ${domains.length} domain(s) via 1.1.1.1 / 8.8.8.8\n`));
for (const d of domains) await auditDomain(d);

// --- summary ---------------------------------------------------------------
const fails = findings.filter((f) => f.level === "FAIL").length;
const warns = findings.filter((f) => f.level === "WARN").length;
console.log("\n" + bold("Summary:"), `${FAIL} ${fails}   ${WARN} ${warns}`);
// Exit non-zero if any hard failures, so this is CI-friendly.
process.exit(fails ? 1 : 0);
