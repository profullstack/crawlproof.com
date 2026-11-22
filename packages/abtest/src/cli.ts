// abtest: read CrawlProof A/B experiments from a terminal.
//   abtest list
//   abtest stats <experiment-key> [--json]
// Auth: CRAWLPROOF_TOKEN (a crp_ API token); base: CRAWLPROOF_URL (default https://crawlproof.com).
import { createClient } from "./client";
import type { Summary } from "./stats";

declare const process: { argv: string[]; env: Record<string, string | undefined>; exit(code: number): never; stdout: { write(s: string): void } };

const args = process.argv.slice(2);
const json = args.includes("--json");
const [cmd, key] = args.filter((a) => !a.startsWith("--"));
const client = createClient({ token: process.env.CRAWLPROOF_TOKEN, baseUrl: process.env.CRAWLPROOF_URL, failOpen: false, timeoutMs: 15_000 });
const out = (s: string) => process.stdout.write(s + "\n");
const pct = (x: number) => `${(x * 100).toFixed(2)}%`;

function table(s: Summary) {
  out(["arm", "exposed", "converted", "rate", "95% CI", "lift", "p", "P(beat ctl)", "revenue", "rev/exposed"].join("\t"));
  for (const a of s.arms) {
    out(
      [
        a.arm + (a.isControl ? " (control)" : ""),
        a.exposed,
        a.converted,
        pct(a.rate),
        `${pct(a.ci.low)}-${pct(a.ci.high)}`,
        a.lift === null ? "-" : `${a.lift >= 0 ? "+" : ""}${(a.lift * 100).toFixed(1)}%`,
        a.pValue === null ? "-" : a.pValue.toPrecision(2),
        a.probabilityToBeatControl === null ? "-" : pct(a.probabilityToBeatControl),
        a.revenue.toFixed(2),
        a.revenuePerExposed.toFixed(2),
      ].join("\t"),
    );
    for (const [name, e] of Object.entries(a.events)) out(`  ${name}: ${e.count} by ${e.units} units (${e.perExposed.toFixed(2)} per exposed)`);
  }
  out("");
  out(s.verdict.text);
}

async function main() {
  if (cmd === "list") {
    const r = await client.list();
    if (!r.ok) throw new Error(r.error);
    if (json) return out(JSON.stringify(r.experiments, null, 2));
    for (const e of r.experiments) out(`${e.key}\t${e.status}\t${e.name ?? ""}`);
    return;
  }
  if (cmd === "stats" && key) {
    const r = await client.stats(key);
    if (!r.ok) throw new Error(r.error);
    if (json) return out(JSON.stringify(r, null, 2));
    out(`${r.experiment.name ?? key} (${r.experiment.status})`);
    table(r.summary);
    return;
  }
  out("usage: abtest list | abtest stats <experiment-key> [--json]   (CRAWLPROOF_TOKEN=crp_...)");
  process.exit(cmd ? 1 : 0);
}

main().catch((e) => {
  out(`abtest: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
