// The executable entry. No shebang here: build.mjs adds one as a banner, and
// two of them is a syntax error rather than a harmless duplicate.
import { main } from "./cli";

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code ?? 0;
});
