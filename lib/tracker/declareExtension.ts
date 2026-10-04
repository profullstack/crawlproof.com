// The "declare me" Chrome extension for an agent's (or a person's) browser.
//
// An unpacked Manifest V3 extension with one declarativeNetRequest rule: set
// `Crawlproof-Actor: <cpa_ token>` on requests to <base>/api/track and nothing
// else. Scoping the header to the beacon endpoint is the point. A blanket
// "extra header on every request" (Playwright extraHTTPHeaders, Puppeteer
// setExtraHTTPHeaders) hands the token to every site the agent visits, and any
// of them could replay it to pose as that agent.
//
// No dependencies, so both CLIs can bundle it. `crawlproof actors extension`
// writes these files; Chrome loads them with --load-extension=<dir>.

export type ExtensionFiles = Record<"manifest.json" | "rules.json" | "README.txt", string>;

/** "https://crawlproof.com/" -> "https://crawlproof.com". Throws on a non-http(s) base. */
export function trackOrigin(base: string): string {
  const u = new URL(base);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`not an http(s) URL: ${base}`);
  return u.origin;
}

export function declareExtensionFiles(input: { token: string; base: string; who: string }): ExtensionFiles {
  if (!/^cpa_[A-Za-z0-9_-]{32,124}$/.test(input.token)) throw new Error("not a cpa_ token");
  const origin = trackOrigin(input.base);
  const manifest = {
    manifest_version: 3,
    name: "CrawlProof declared actor",
    version: "1.0.0",
    description: `Declares this browser's visits as ${input.who} to the CrawlProof tracker. Adds one header to ${origin}/api/track requests only.`,
    // WithHostAccess: modifyHeaders needs host access to the request URL and
    // to the page that sends it, which can be any tracked site.
    permissions: ["declarativeNetRequestWithHostAccess"],
    host_permissions: ["<all_urls>"],
    declarative_net_request: {
      rule_resources: [{ id: "declare", enabled: true, path: "rules.json" }],
    },
  };
  const rules = [
    {
      id: 1,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [{ header: "Crawlproof-Actor", operation: "set", value: input.token }],
      },
      condition: {
        // Left-anchored on the full origin + path: a lookalike host or a page
        // whose own URL merely contains this string does not match.
        urlFilter: `|${origin}/api/track`,
        resourceTypes: ["xmlhttprequest", "ping", "other"],
      },
    },
  ];
  const readme = [
    `CrawlProof declared actor: ${input.who}`,
    "",
    `Every page this browser loads that runs the CrawlProof tracker is counted as`,
    `${input.who}. The token goes only to ${origin}/api/track.`,
    "",
    "Load it:",
    "  chrome --load-extension=$PWD --disable-extensions-except=$PWD ...",
    "  Puppeteer:   args: [`--load-extension=${dir}`, `--disable-extensions-except=${dir}`]",
    "  Playwright:  chromium.launchPersistentContext(profile, { args: [same two flags] })",
    "  chrome-devtools-mcp: --chromeArg=--load-extension=<dir> --chromeArg=--disable-extensions-except=<dir>",
    "",
    "Branded Google Chrome 137+ ignores --load-extension; use Chromium or Chrome for Testing.",
    "rules.json holds the token: keep this folder private (chmod 700).",
    "Revoke: crawlproof actors revoke <email> --token-id=<token id>",
    "",
  ].join("\n");
  return {
    "manifest.json": `${JSON.stringify(manifest, null, 2)}\n`,
    "rules.json": `${JSON.stringify(rules, null, 2)}\n`,
    "README.txt": readme,
  };
}
