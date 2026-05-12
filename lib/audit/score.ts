import type { Finding } from "./types";

// Weight by severity (priority): critical (1) is heavily punished.
const WEIGHT = { 1: 25, 2: 15, 3: 8, 4: 4, 5: 1 } as const;

export function scoreFindings(findings: Finding[]): number {
  let max = 0;
  let earned = 0;
  for (const f of findings) {
    const w = WEIGHT[f.priority] ?? 5;
    max += w;
    if (f.status === "pass") earned += w;
    else if (f.status === "warn") earned += w * 0.5;
    else if (f.status === "unknown") earned += w * 0.3;
    // fail: 0
  }
  if (max === 0) return 0;
  return Math.round((earned / max) * 100);
}
