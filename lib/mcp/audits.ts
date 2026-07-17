// Audits capability for the CrawlProof MCP server. AEO audits are ASYNCHRONOUS
// (the worker runs each engine and fills in the score later), so this is a
// start + poll pair: start_audit kicks off a run and returns a run id;
// get_audit reports the per-engine status/scores for that run. Mirrors the
// in-app runAudit flow (validate → credits → insert queued rows → notify the
// worker /enqueue). Scoped to the authenticated user throughout.

import crypto from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { env } from "@/lib/env";
import { serviceClient } from "@/lib/supabase/service";
import { isAllowedTargetUrl, consumeCredit, refundCredit, checkPerTargetLimit } from "@/lib/rateLimit";
import {
  ENGINES,
  selectionCost,
  engineAvailable,
  dedupeEngines,
  DEFAULT_PROJECT_ENGINES,
  type Engine,
} from "@/lib/credits";
import { newShareToken } from "@/lib/shareToken";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getUserId(extra: any): string {
  const info = extra?.authInfo;
  const uid = info?.extra?.userId ?? info?.clientId;
  if (!uid || typeof uid !== "string") throw new Error("Unauthenticated.");
  return uid;
}
function textResult(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}
function errorResult(s: string) {
  return { content: [{ type: "text" as const, text: s }], isError: true };
}

async function notifyWorker(auditId: string): Promise<void> {
  if (!env.workerUrl) return;
  try {
    await fetch(`${env.workerUrl}/enqueue`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-worker-secret": env.workerSecret },
      body: JSON.stringify({ auditId }),
    });
  } catch {
    // Fall back to the worker's periodic sweep, which also picks up queued rows.
  }
}

const VALID_ENGINES = new Set(Object.keys(ENGINES));

export function registerAuditTools(server: McpServer): void {
  server.registerTool(
    "start_audit",
    {
      description:
        "Start an AEO (Answer Engine Optimization) audit of a URL. Async — returns a run id; poll get_audit for scores. Engines default to rule+dns (free); AI engines (claude, openai, gemini, perplexity, …) cost credits. Available engines: " +
        Object.keys(ENGINES).join(", ") +
        ".",
      inputSchema: {
        url: z.string().describe("The page/site URL to audit."),
        engines: z
          .array(z.string())
          .optional()
          .describe("Engines to run. Omit for the free default (rule, dns)."),
      },
    },
    async (args, extra) => {
      const userId = getUserId(extra);
      const check = isAllowedTargetUrl(args.url);
      if (!check.ok) return errorResult(check.reason);
      const target = check.url;

      let engines: Engine[] =
        args.engines && args.engines.length
          ? dedupeEngines(args.engines.filter((e): e is Engine => VALID_ENGINES.has(e)))
          : DEFAULT_PROJECT_ENGINES;
      if (!engines.length) engines = DEFAULT_PROJECT_ENGINES;
      const unavailable = engines.find((e) => !engineAvailable(e));
      if (unavailable) return errorResult(`Engine "${ENGINES[unavailable].label}" isn't available.`);

      const cost = selectionCost(engines);
      if (cost > 0) {
        const c = await consumeCredit(userId, cost);
        if (!c.ok)
          return errorResult(
            `Need ${cost} credit${cost === 1 ? "" : "s"} for ${engines.length} engine${
              engines.length === 1 ? "" : "s"
            } — not enough balance. Buy credits in Billing.`,
          );
      }
      if (!(await checkPerTargetLimit(target, userId))) {
        if (cost > 0) await refundCredit(userId, cost);
        return errorResult("This URL was just audited — try again in ~30 seconds.");
      }

      const sb = serviceClient();
      const scanRunId = crypto.randomUUID();
      const inserts = engines.map((e) => ({
        target_url: target,
        project_id: null,
        owner_id: userId,
        status: "queued",
        share_token: newShareToken(),
        triggered_by: "manual", // CHECK constraint allows only manual|scheduled
        engine: e,
        scan_run_id: scanRunId,
      }));
      const { data: rows, error } = await sb.from("audits").insert(inserts).select("id");
      if (error || !rows) {
        if (cost > 0) await refundCredit(userId, cost);
        return errorResult(error?.message ?? "Failed to create the audit.");
      }
      for (const r of rows as { id: string }[]) await notifyWorker(r.id);

      return textResult(
        `Started AEO audit of ${target} — engines: ${engines.join(", ")} ${
          cost > 0 ? `(spent ${cost} credit${cost === 1 ? "" : "s"})` : "(free)"
        }.\nRun id: ${scanRunId}\nPoll get_audit({ run_id: "${scanRunId}" }) — engines finish in ~10–60s each.`,
      );
    },
  );

  server.registerTool(
    "get_audit",
    {
      description: "Get the status + scores of an audit run started by start_audit.",
      inputSchema: { run_id: z.string().describe("The run id returned by start_audit.") },
    },
    async (args, extra) => {
      const userId = getUserId(extra);
      const { data } = await serviceClient()
        .from("audits")
        .select("engine, status, score, failed_reason, share_token")
        .eq("scan_run_id", args.run_id)
        .eq("owner_id", userId);
      const rows =
        (data as {
          engine: string;
          status: string;
          score: number | null;
          failed_reason: string | null;
          share_token: string | null;
        }[]) ?? [];
      if (!rows.length) return errorResult("No audit found for that run id.");

      const site = env.siteUrl.replace(/\/$/, "");
      const lines = rows.map((a) => {
        if (a.status === "complete")
          return `✓ ${a.engine}: ${a.score ?? "—"}/100${a.share_token ? ` → ${site}/r/${a.share_token}` : ""}`;
        if (a.status === "failed")
          return `✗ ${a.engine}: failed${a.failed_reason ? ` (${a.failed_reason})` : ""}`;
        return `… ${a.engine}: ${a.status}`;
      });
      const done = rows.filter((a) => a.status === "complete" || a.status === "failed").length;
      const header = done === rows.length ? "Done." : `${done}/${rows.length} engines finished (still running)…`;
      return textResult(`${header}\n${lines.join("\n")}`);
    },
  );
}
