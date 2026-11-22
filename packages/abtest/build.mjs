// Bundle src/ into dist/index.js (+ the CLI) and emit type declarations.
// Run from the crawlproof.com checkout: esbuild and tsc come from its node_modules.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { chmod, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
await rm(join(here, "dist"), { recursive: true, force: true });
const common = { bundle: true, format: "esm", target: "es2022" };
await build({ ...common, platform: "neutral", entryPoints: [join(here, "src", "index.ts")], outfile: join(here, "dist", "index.js") });
await build({
  ...common,
  platform: "node",
  entryPoints: [join(here, "src", "cli.ts")],
  outfile: join(here, "dist", "cli.js"),
  banner: { js: "#!/usr/bin/env node" },
});
await chmod(join(here, "dist", "cli.js"), 0o755);
const tsc = join(here, "..", "..", "node_modules", ".bin", "tsc");
execFileSync(tsc, ["-p", join(here, "tsconfig.json")], { stdio: "inherit" });
