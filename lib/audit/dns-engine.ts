import Anthropic from "@anthropic-ai/sdk";
// zod/v4: backendAi and the SDK both call z.toJSONSchema(), a v4-only API.
// See the note in claude-engine.ts.
import { z } from "zod/v4";
import { env } from "../env";
import { generateStructuredOutput, hasBackendAiTextProvider } from "../lx/backendAi";
import { collectDnsRecords, dnsBaselineFindings, type DnsRecords } from "./dns";
import { scoreFindings } from "./score";
import type { ClaudeAuditResult } from "./claude-engine";
import type { Finding } from "./types";

// The "DNS Analyzer" scan type. Unlike the LLM AEO engines this does NOT crawl
// the site — it resolves the domain's DNS footprint deterministically
// (lib/audit/dns) and asks Claude to reason over the *records themselves*,
// flagging what's missing / weak / harmful and emitting paste-ready fixes.
// It's a free engine (cost 0 in lib/credits), so the AI step is best-effort:
// if the key is missing or the call fails we still return the deterministic
// baseline rather than failing the scan.

const FindingSchema = z.object({
  check_key: z.string(),
  status: z.enum(["pass", "warn", "fail", "unknown"]),
  title: z.string(),
  detail: z.string().optional(),
  priority: z.number().int(),
});

const ResultSchema = z.object({
  score: z.number(),
  findings: z.array(FindingSchema),
  markdown: z.string(),
});

const SYSTEM_PROMPT = `You are CrawlProof's DNS Analyzer. You are given the fully-resolved DNS records for a single domain as JSON — you do NOT have web tools and must reason only from the records provided.

Analyze the domain's DNS footprint with a focus on email deliverability and anti-spoofing, plus general hygiene:
- Mail authentication: SPF (presence, include count vs. the RFC 7208 10-lookup limit, terminal -all/~all/+all), DKIM (which selectors resolved), DMARC (policy p=, presence of rua reporting, alignment).
- Mail routing: MX records and any provider-specific Return-Path / bounce subdomain (e.g. a "send." subdomain for Resend with its own SPF + feedback MX).
- Transport hardening: MTA-STS, TLS-RPT, BIMI.
- General: A/AAAA, NS, SOA, and CAA (cert-issuance restriction).

For every issue produce a finding. Classify harm honestly:
- fail = harmful or a real spoofing/deliverability risk (e.g. no SPF, no DMARC, p reject without alignment, +all).
- warn = weak or monitor-only (p=none, missing rua, ~all where -all is wanted, missing CAA/MTA-STS).
- pass = correctly configured.
Use priority 1 (critical) … 5 (informational). check_key must be a stable snake/dot key like "dns.spf" or "dns.dmarc.rua".

When a record should be ADDED or CHANGED, give the exact paste-ready value (host, type, value) in the finding detail. Do not invent secret key material (DKIM keys, verification tokens) — instruct the user to copy those from their mail provider's dashboard.

Also produce a "markdown" field: a concise report with a short verdict, a table or bullet list of findings with ✅ / ⚠️ / ❌ status, and a "Recommended records to add" section with paste-ready rows. Be direct and specific. Quote the actual record values from the JSON — don't paraphrase.

Set "score" 0–100 reflecting overall DNS/email health (a domain with no SPF and no DMARC should score low).`;

function buildUserPrompt(rec: DnsRecords): string {
  return [
    `Domain: ${rec.domain}`,
    "",
    "Resolved DNS records (JSON):",
    "```json",
    JSON.stringify(rec, null, 2),
    "```",
    "",
    "Analyze these records and return the structured result. Remember: no SPF and/or no DMARC are FAIL-level spoofing risks; p=none or a missing rua= is WARN.",
  ].join("\n");
}

function baselineMarkdown(rec: DnsRecords, findings: Finding[]): string {
  const glyph = (s: Finding["status"]) =>
    s === "pass" ? "✅" : s === "warn" ? "⚠️" : s === "fail" ? "❌" : "❓";
  const lines = [
    `# DNS Analysis — ${rec.domain}`,
    "",
    "_AI analysis was unavailable; showing deterministic baseline checks._",
    "",
    ...findings
      .filter((f) => f.check_key !== "dns.inventory")
      .map((f) => `- ${glyph(f.status)} **${f.title}**${f.detail ? `\n  ${f.detail.replace(/\n/g, "\n  ")}` : ""}`),
    "",
    "## Footprint",
    "```",
    `A:    ${rec.a.join(", ") || "—"}`,
    `MX:   ${rec.mx.map((m) => `${m.priority} ${m.exchange}`).join(", ") || "—"}`,
    `NS:   ${rec.ns.join(", ") || "—"}`,
    `SPF:  ${rec.spf ?? "—"}`,
    `DMARC:${rec.dmarc ?? "—"}`,
    `DKIM: ${rec.dkim.map((d) => d.selector).join(", ") || "none found"}`,
    "```",
  ];
  return lines.join("\n");
}

export async function dnsAudit(targetUrl: string): Promise<ClaudeAuditResult> {
  const started = Date.now();
  const records = await collectDnsRecords(targetUrl);
  const baseline = dnsBaselineFindings(records);
  const inventory = baseline.find((f) => f.check_key === "dns.inventory");

  // AI step — best effort. Fall back to the deterministic baseline on any
  // failure so this free scan never hard-fails the worker.
  if (hasBackendAiTextProvider({ anthropicApiKey: env.anthropicApiKey, openaiApiKey: env.openaiApiKey })) {
    try {
      const { output: parsed } = await generateStructuredOutput({
        name: "dns_audit",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        schema: ResultSchema as any,
        system: SYSTEM_PROMPT,
        user: buildUserPrompt(records),
        maxTokens: 16000,
        anthropicModel: "claude-sonnet-4-6",
        anthropic: env.anthropicApiKey ? new Anthropic({ apiKey: env.anthropicApiKey }) : null,
        anthropicCacheSystemPrompt: true,
      }) as { output: z.infer<typeof ResultSchema> };

      const aiFindings: Finding[] = parsed.findings.map(
        (f: z.infer<typeof FindingSchema>) => ({
          section: "DNS",
          check_key: f.check_key.startsWith("dns.") ? f.check_key : `dns.${f.check_key}`,
          status: f.status,
          title: f.title,
          detail: f.detail ?? undefined,
          evidence: undefined,
          priority: Math.min(5, Math.max(1, Math.round(f.priority))) as Finding["priority"],
        }),
      );

      // Keep the inventory finding (carries the raw records as evidence) and
      // let the AI findings supersede the baseline heuristics.
      const findings = inventory ? [inventory, ...aiFindings] : aiFindings;
      return {
        score: Math.round(Math.max(0, Math.min(100, parsed.score))),
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
        markdown: parsed.markdown,
      };
    } catch (err) {
      console.warn("[dns-engine] AI analysis failed; using baseline", err);
    }
  }

  // Baseline-only path.
  const score = scoreFindings(baseline);
  return {
    score,
    findings: baseline,
    summary: {
      pagesCrawled: 0,
      pass: baseline.filter((f) => f.status === "pass").length,
      warn: baseline.filter((f) => f.status === "warn").length,
      fail: baseline.filter((f) => f.status === "fail").length,
      unknown: baseline.filter((f) => f.status === "unknown").length,
      dataFound: [],
      durationMs: Date.now() - started,
    },
    markdown: baselineMarkdown(records, baseline),
  };
}
