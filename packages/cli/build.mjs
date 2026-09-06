// Bundle the publishable CLI out of the app's own source.
//
// The point of bundling rather than moving files is that lib/dashboard/* and
// cli/dashboard.ts stay where the test suite already covers them and where the
// in-repo CLI already imports them. The package is a build artifact of the
// same code, so there is one implementation and it cannot drift.
//
// hqtui and the CoinPay SDK stay external: they are real dependencies with
// their own release cadence, declared in package.json and installed alongside.

import { build } from "esbuild";
import { chmod, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "dist", "cli.mjs");

const pkg = JSON.parse(await readFile(join(here, "package.json"), "utf8"));

await build({
  entryPoints: [join(here, "src", "bin.ts")],
  outfile: out,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // Anything with its own version belongs in package.json, not inlined here.
  external: [...Object.keys(pkg.dependencies ?? {}), "node:*"],
  banner: { js: "#!/usr/bin/env node" },
  legalComments: "none",
  logLevel: "info",
});

await chmod(out, 0o755);
console.log(`built ${out}`);
