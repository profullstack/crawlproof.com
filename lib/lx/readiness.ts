// Server-side readiness check for the Autoblog pipeline.
//
// Each capability maps env-vars → user-facing actions that depend on
// them. When something is missing we want the dashboard to tell the
// customer *which button is going to fail* before they click it,
// instead of returning a generic "Could not save" later.
//
// We also do a live health probe of the worker (one-shot, 2s budget)
// because the worker may be deployed as a separate Railway service —
// its env can be misconfigured even if the app's looks fine.

import { env } from "@/lib/env";

const PROBE_TIMEOUT_MS = 2000;

export type ReadinessIssue = {
  key:
    | "worker"
    | "openai"
    | "anthropic"
    | "dataforseo"
    | "cron";
  blocks: string[]; // human-readable list of actions that won't work
};

async function probeWorker(): Promise<boolean> {
  if (!env.workerUrl) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${env.workerUrl}/health`, {
      method: "GET",
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function checkAutoblogReadiness(): Promise<{
  ok: boolean;
  issues: ReadinessIssue[];
}> {
  const issues: ReadinessIssue[] = [];

  const workerHealthy = await probeWorker();
  if (!workerHealthy) {
    issues.push({
      key: "worker",
      blocks: [
        "Sitemap refresh",
        "Generate keywords",
        "Generate article now",
        "Retry failed article",
      ],
    });
  }
  if (!env.openaiApiKey) {
    issues.push({
      key: "openai",
      blocks: ["Sitemap embeddings", "Article featured image"],
    });
  }
  if (!env.anthropicApiKey) {
    issues.push({
      key: "anthropic",
      blocks: ["Article body generation"],
    });
  }
  if (!env.dataforseoLogin || !env.dataforseoPassword) {
    issues.push({
      key: "dataforseo",
      blocks: ["Keyword research"],
    });
  }
  if (!env.cronSecret) {
    issues.push({
      key: "cron",
      blocks: ["Scheduled hourly publish"],
    });
  }

  return { ok: issues.length === 0, issues };
}

export function readinessLabel(key: ReadinessIssue["key"]): string {
  switch (key) {
    case "worker":
      return "Worker unreachable";
    case "openai":
      return "OPENAI_API_KEY not set";
    case "anthropic":
      return "ANTHROPIC_API_KEY not set";
    case "dataforseo":
      return "DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD not set";
    case "cron":
      return "CRON_SECRET not set";
  }
}
