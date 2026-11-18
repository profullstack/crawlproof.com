import type { Finding } from "@/lib/audit/types";

/**
 * The fixes to lead a report with: failures before warnings, then by priority
 * (1 = most important). Recommendations and to-do items that do not count
 * toward the score are left out, so the list matches what moves the number.
 * Pure.
 */
export function topFixes(findings: Finding[], n = 5): Finding[] {
  const rank = (s: Finding["status"]) => (s === "fail" ? 0 : s === "warn" ? 1 : 2);
  return findings
    .filter((f) => (f.status === "fail" || f.status === "warn") && !/^(rec|todo)\./.test(f.check_key))
    .sort((a, b) => rank(a.status) - rank(b.status) || (a.priority ?? 5) - (b.priority ?? 5))
    .slice(0, n);
}

/** Reports made for outreach stay off search engines; everything else follows the owner rule. */
export function reportIndexable(audit: { owner_id: string | null; funnel_source?: string | null }): boolean {
  if (audit.owner_id) return false;
  return audit.funnel_source !== "outreach";
}
