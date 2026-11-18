// `crawlproof batch` and `crawlproof ranking` (R4, R5 of the validation test).
//
//   crawlproof batch domains.csv [--source outreach|ranking] [--out results.csv]
//                    [--batch <id>] [--timeout 30]
//   crawlproof batch status <batch_id> [--out results.csv]
//   crawlproof ranking publish --slug <slug> --title "..." --list "..." \
//                    --method "..." --batch <batch_id> [--draft]
//
// Input: a CSV (or plain list) whose first column is a domain or URL; a
// header row is skipped. Output: domain,score,top_issue,report_url.

type ApiCall = (
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
) => Promise<{ status: number; json: Record<string, unknown> }>;

type Out = { write: (line: string) => void; error: (line: string) => void };

/** First column of each non-empty line, header and comments skipped. Pure. */
export function parseDomainsCsv(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    let cell = line.split(",")[0]!.trim();
    if (cell.startsWith('"') && cell.endsWith('"')) cell = cell.slice(1, -1).trim();
    if (!cell) continue;
    // A header row: no dot in it ("domain", "website", "url").
    if (!cell.includes(".")) continue;
    out.push(cell);
  }
  return [...new Set(out)];
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export type ResultRow = { domain: string; score: number | null; top_issue: string; report_url: string; status: string };

/** The output CSV. Pure. */
export function toResultsCsv(rows: ResultRow[]): string {
  const lines = ["domain,score,top_issue,report_url"];
  for (const r of rows) {
    lines.push([r.domain, r.status === "complete" ? r.score : r.status, r.top_issue, r.report_url].map(csvCell).join(","));
  }
  return lines.join("\n") + "\n";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function poll(api: ApiCall, batchId: string, timeoutMin: number, out: Out): Promise<ResultRow[]> {
  const deadline = Date.now() + timeoutMin * 60 * 1000;
  for (;;) {
    const res = await api("GET", `/api/admin/batch-audits?batch=${batchId}`);
    if (res.status !== 200) throw new Error(`status ${res.status}: ${String(res.json.error ?? "")}`);
    const rows = (res.json.rows ?? []) as ResultRow[];
    const done = Number(res.json.done ?? 0);
    const total = Number(res.json.total ?? 0);
    out.error(`[batch] ${done}/${total} finished`);
    if (total > 0 && done >= total) return rows;
    if (Date.now() > deadline) {
      out.error(`[batch] timeout after ${timeoutMin} min; writing what finished. Re-check with: crawlproof batch status ${batchId}`);
      return rows;
    }
    await sleep(15_000);
  }
}

export async function runBatch(
  positional: string[],
  flags: Record<string, string | boolean>,
  api: ApiCall,
  out: Out,
  fs: { read: (p: string) => string; write: (p: string, s: string) => void },
): Promise<number> {
  const emit = (rows: ResultRow[]) => {
    const csv = toResultsCsv(rows);
    if (typeof flags.out === "string") {
      fs.write(flags.out, csv);
      out.error(`[batch] wrote ${rows.length} rows to ${flags.out}`);
    } else {
      out.write(csv.trimEnd());
    }
  };

  if (positional[0] === "status") {
    const id = positional[1];
    if (!id) {
      out.error("usage: crawlproof batch status <batch_id> [--out results.csv]");
      return 2;
    }
    emit(await poll(api, id, 0, out));
    return 0;
  }

  const file = positional[0];
  if (!file) {
    out.error("usage: crawlproof batch <domains.csv> [--source outreach|ranking] [--out results.csv] [--batch <id>] [--timeout 30]");
    return 2;
  }
  const source = typeof flags.source === "string" ? flags.source : "outreach";
  if (source !== "outreach" && source !== "ranking") {
    out.error("--source must be outreach or ranking");
    return 2;
  }
  const domains = parseDomainsCsv(fs.read(file));
  if (domains.length === 0) {
    out.error("No domains found in the first column.");
    return 2;
  }
  const timeout = Number(flags.timeout ?? 30) || 30;

  let batchId = typeof flags.batch === "string" ? flags.batch : undefined;
  for (let i = 0; i < domains.length; i += 100) {
    const res = await api("POST", "/api/admin/batch-audits", {
      domains: domains.slice(i, i + 100),
      source,
      ...(batchId ? { batch_id: batchId } : {}),
    });
    if (res.status !== 200) {
      out.error(`create failed ${res.status}: ${String(res.json.error ?? "")}`);
      return 1;
    }
    batchId = String(res.json.batch_id);
    for (const r of (res.json.rejected ?? []) as { domain: string; reason: string }[]) {
      out.error(`[batch] skipped ${r.domain}: ${r.reason}`);
    }
  }
  out.error(`[batch] ${domains.length} domains queued as batch ${batchId} (source ${source})`);
  emit(await poll(api, batchId!, timeout, out));
  return 0;
}

export async function runRanking(
  positional: string[],
  flags: Record<string, string | boolean>,
  api: ApiCall,
  out: Out,
): Promise<number> {
  if (positional[0] !== "publish") {
    out.error('usage: crawlproof ranking publish --slug <slug> --title "..." --list "..." --method "..." --batch <batch_id> [--draft]');
    return 2;
  }
  const need = ["slug", "title", "list", "method", "batch"];
  const missing = need.filter((k) => typeof flags[k] !== "string");
  if (missing.length) {
    out.error(`missing --${missing.join(", --")}`);
    return 2;
  }
  const res = await api("POST", "/api/admin/rankings", {
    slug: flags.slug,
    title: flags.title,
    list_name: flags.list,
    method: flags.method,
    batch_id: flags.batch,
    publish: !flags.draft,
  });
  if (res.status !== 200) {
    out.error(`publish failed ${res.status}: ${String(res.json.error ?? "")}`);
    return 1;
  }
  out.write(String(res.json.url));
  return 0;
}
