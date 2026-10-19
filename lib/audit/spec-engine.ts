// specification.website MCP engine — fetches the audit_url prompt from
// https://mcp.specification.website/mcp, then checks every item it can verify from
// the page itself (spec-verify.ts). Free; no LLM required.
//
// The score counts verified items only. An item that needs a browser or a person
// (contrast, keyboard traps, Core Web Vitals) is listed as not verified and left out
// of the score, rather than being scored as half a failure for every site.

import * as cheerio from "cheerio";
import { fetchPage } from "./fetch";
import { fetchSpecAuditPlan } from "./spec-mcp";
import { specSlug, verifySpecItem, type SpecExtras } from "./spec-verify";
import { scoreFindings } from "./score";
import type { AuditResult, FetchedPage, Finding } from "./types";

type SpecAuditResult = AuditResult & { markdown: string };

type PlanItem = { title: string; tier: string; description: string; reference?: string };

// Each checklist item in the prompt looks like:
//   - **Item name** (required) — Description text.
//     Reference: https://specification.website/spec/…/
export function parsePlan(plan: string): PlanItem[] {
  const items: PlanItem[] = [];
  const lines = plan.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.trim().match(/^-\s+\*\*(.+?)\*\*\s+\((\w+)\)\s+[—–-]\s+(.+)/);
    if (!m) continue;
    const ref = lines[i + 1]?.trim().match(/^Reference:\s*(https?:\/\/\S+)/)?.[1];
    items.push({ title: m[1]!.trim(), tier: m[2]!.toLowerCase(), description: m[3]!.trim(), reference: ref });
  }
  return items;
}

/** One finding per plan item: verified pass/warn/fail, or unknown when no check exists. */
export function itemsToFindings(items: PlanItem[], page: FetchedPage | null, extras: SpecExtras): Finding[] {
  const $ = page?.rawHtml ? cheerio.load(page.rawHtml) : null;
  return items.map((item, i) => {
    const verdict = page && $ ? verifySpecItem(specSlug(item.reference), page, $, extras) : null;
    const reference = item.reference ? `\n\nReference: ${item.reference}` : "";
    if (!verdict) {
      return {
        section: "Website Specification",
        check_key: `spec.mcp.${i + 1}`,
        status: "unknown",
        title: `[${item.tier}] ${item.title}`,
        detail: `Not verified automatically (needs a browser or a person). ${item.description}${reference}`,
        evidence: { tier: item.tier, verified: false, ...(item.reference ? { reference: item.reference } : {}) },
        priority: 5,
      } satisfies Finding;
    }
    return {
      section: "Website Specification",
      check_key: `spec.mcp.${i + 1}`,
      status: verdict.status,
      title: `[${item.tier}] ${item.title}`,
      detail: `${verdict.note}${reference}`,
      evidence: { tier: item.tier, verified: true, ...(item.reference ? { reference: item.reference } : {}) },
      // Every item of a tier weighs the same whether it passes or fails, so the score reads
      // as the share of the spec the page meets.
      priority: item.tier === "required" ? 2 : 4,
    } satisfies Finding;
  });
}

/** Score the verified items; when none could be checked there is nothing to score. */
export function specScore(findings: Finding[]): number {
  const verified = findings.filter((f) => (f.evidence as { verified?: boolean } | undefined)?.verified);
  return verified.length ? scoreFindings(verified) : 50;
}

async function probe(url: string): Promise<{ status: number; location: string | null; html: boolean } | null> {
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { "user-agent": "CrawlProofBot/1.0 (+https://crawlproof.com/bot)" } });
    const html = /text\/html/i.test(res.headers.get("content-type") ?? "") && (await res.text()).length > 200;
    return { status: res.status, location: res.headers.get("location"), html };
  } catch {
    return null;
  }
}

async function gatherExtras(page: FetchedPage): Promise<SpecExtras> {
  const u = new URL(page.finalUrl || page.url);
  const missing = new URL(`/crawlproof-spec-${Date.now().toString(36)}-missing`, u.origin).toString();
  const plain = u.protocol === "https:" ? `http://${u.host}${u.pathname}${u.search}` : null;
  const [nf, http] = await Promise.all([probe(missing), plain ? probe(plain) : Promise.resolve(null)]);
  return { notFound: nf && { status: nf.status, html: nf.html }, httpRedirect: http && { status: http.status, location: http.location } };
}

function renderMarkdown(targetUrl: string, findings: Finding[], score: number): string {
  const verified = findings.filter((f) => (f.evidence as { verified?: boolean } | undefined)?.verified);
  const rest = findings.filter((f) => !(f.evidence as { verified?: boolean } | undefined)?.verified);
  const icon = { pass: "✅", warn: "⚠️", fail: "❌", unknown: "❔" } as const;
  const row = (f: Finding) => `| ${icon[f.status]} | ${f.title.replace(/\|/g, "\\|")} | ${(f.detail ?? "").split("\n\n")[0]!.replace(/\|/g, "\\|")} |`;
  return [
    `# Website Specification Audit for ${targetUrl}`,
    ``,
    `Checklist from [specification.website](https://specification.website/) via its [MCP server](https://mcp.specification.website/mcp), checked against the live page.`,
    ``,
    `**Score: ${score}/100** across ${verified.length} verified item${verified.length === 1 ? "" : "s"}: ${verified.filter((f) => f.status === "pass").length} pass, ${verified.filter((f) => f.status === "warn").length} warn, ${verified.filter((f) => f.status === "fail").length} fail.`,
    ``,
    `## Verified`,
    ``,
    `| | Item | Result |`,
    `|---|---|---|`,
    ...verified.map(row),
    ...(rest.length
      ? [``, `## Not verified automatically`, ``, `These need a browser or a person, so they are not part of the score.`, ``, `| | Item | What to check |`, `|---|---|---|`, ...rest.map(row)]
      : []),
    ``,
  ].join("\n");
}

export async function specAudit(targetUrl: string): Promise<SpecAuditResult> {
  const started = Date.now();

  const plan = await fetchSpecAuditPlan(targetUrl);

  if (!plan) {
    const findings: Finding[] = [
      {
        section: "Website Specification",
        check_key: "spec.mcp.unavailable",
        status: "warn",
        title: "specification.website MCP server did not respond",
        detail:
          "The audit checklist could not be retrieved from https://mcp.specification.website/mcp. The server may be temporarily unavailable.",
        priority: 3,
      },
    ];
    return {
      score: 50,
      findings,
      markdown: `# Website Specification Audit\n\n_Could not reach specification.website MCP server._\n`,
      summary: {
        pagesCrawled: 0,
        pass: 0,
        warn: 1,
        fail: 0,
        unknown: 0,
        dataFound: [],
        durationMs: Date.now() - started,
      },
    };
  }

  const page = await fetchPage(targetUrl);
  const usable = page.status >= 200 && page.status < 400 && page.rawHtml ? page : null;
  const extras = usable ? await gatherExtras(usable) : {};
  const findings = itemsToFindings(parsePlan(plan), usable, extras);
  const score = specScore(findings);

  return {
    score,
    findings,
    markdown: renderMarkdown(targetUrl, findings, score),
    summary: {
      pagesCrawled: usable ? 1 : 0,
      pass: findings.filter((f) => f.status === "pass").length,
      warn: findings.filter((f) => f.status === "warn").length,
      fail: findings.filter((f) => f.status === "fail").length,
      unknown: findings.filter((f) => f.status === "unknown").length,
      dataFound: [],
      durationMs: Date.now() - started,
    },
  };
}
