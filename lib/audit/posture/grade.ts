// Per-category letter grading for the Posture report (Hardenize-style A–F).
//
// Grading is by SEVERITY rubric, not the AEO score weighting — that weighting
// is tuned for content audits and makes a single nice-to-have warning collapse
// a category to F. Hardenize shows amber for missing optional hardening and red
// only for genuine problems, so we map: a critical (priority-1) failure → F,
// any other failure → D, a high-severity (priority ≤2) warning → C, any other
// warning → B, all clear → A.

import type { CheckStatus, Finding } from "../types";

export type Grade = "A" | "B" | "C" | "D" | "F";

// Representative numeric per grade, used only to roll categories into one
// overall 0–100 score for the audit row.
const BAND: Record<Grade, number> = { A: 95, B: 85, C: 72, D: 60, F: 40 };

export function gradeScore(grade: Grade): number {
  return BAND[grade];
}

export function letterFromScore(score: number): Grade {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 55) return "D";
  return "F";
}

/** Map a grade to the report status used by the summary grid. */
export function gradeStatus(grade: Grade): CheckStatus {
  if (grade === "A" || grade === "B") return "pass";
  if (grade === "C" || grade === "D") return "warn";
  return "fail";
}

export function gradeCategory(findings: Finding[]): { grade: Grade } {
  const scored = findings.filter((f) => !f.check_key.endsWith(".inventory"));
  const fails = scored.filter((f) => f.status === "fail");
  const warns = scored.filter((f) => f.status === "warn");
  const unknown = scored.some((f) => f.status === "unknown");

  let grade: Grade;
  if (fails.some((f) => f.priority <= 1)) grade = "F";
  else if (fails.length > 0) grade = "D";
  else if (unknown) grade = "C";
  else if (warns.some((f) => f.priority <= 2)) grade = "C";
  else if (warns.length > 0) grade = "B";
  else grade = "A";
  return { grade };
}
