import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// `curl -fsSL https://crawlproof.com/install.sh | sh` is the CLI's one-line
// install. It is a static file in public/, and the proxy must not run on it:
// the crawl gateway would answer curl's 402 or HTML instead of the script.
const root = join(__dirname, "..");

describe("/install.sh", () => {
  const script = readFileSync(join(root, "public/install.sh"), "utf8");

  it("is a POSIX shell script that installs the scoped package", () => {
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script).toContain('PKG="@profullstack/crawlproof"');
    // The unscoped `crawlproof` on npm is not ours.
    expect(script).not.toMatch(/(?:npm install -g|bun add -g) "?crawlproof\b/);
  });

  it("is excluded from the proxy matcher", () => {
    const source = readFileSync(join(root, "proxy.ts"), "utf8");
    const literal = /matcher:\s*\[\s*"([^"]+)"/.exec(source)?.[1];
    expect(literal).toBeDefined();
    const matcher = new RegExp(`^${literal!.replace(/\\\\/g, "\\")}$`);
    expect(matcher.test("/install.sh")).toBe(false);
    expect(matcher.test("/docs/cli")).toBe(true);
  });
});
