import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { declareExtensionFiles, trackOrigin } from "@/lib/tracker/declareExtension";
import { runActors } from "@/lib/tracker/actorsCli";

// The extension is how an agent's browser declares itself without a code
// change. What has to hold: the token goes to the beacon endpoint and nowhere
// else, and the folder holding it is private.

const TOKEN = "cpa_" + "A".repeat(43);

describe("declareExtensionFiles", () => {
  const files = declareExtensionFiles({ token: TOKEN, base: "https://crawlproof.com/", who: "riotcoder (agent)" });
  const rules = JSON.parse(files["rules.json"]);
  const manifest = JSON.parse(files["manifest.json"]);

  it("sets the header only on <origin>/api/track, left-anchored", () => {
    expect(rules).toHaveLength(1);
    expect(rules[0].condition.urlFilter).toBe("|https://crawlproof.com/api/track");
    expect(rules[0].action.requestHeaders).toEqual([{ header: "Crawlproof-Actor", operation: "set", value: TOKEN }]);
  });

  it("is a Manifest V3 declarativeNetRequest extension with no other powers", () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions).toEqual(["declarativeNetRequestWithHostAccess"]);
    expect(manifest.background).toBeUndefined();
    expect(manifest.content_scripts).toBeUndefined();
  });

  it("follows a self-hosted base", () => {
    const self = JSON.parse(declareExtensionFiles({ token: TOKEN, base: "http://localhost:3000", who: "x" })["rules.json"]);
    expect(self[0].condition.urlFilter).toBe("|http://localhost:3000/api/track");
  });

  it("refuses a non-token and a non-http base", () => {
    expect(() => declareExtensionFiles({ token: "crp_" + "A".repeat(43), base: "https://crawlproof.com", who: "x" })).toThrow();
    expect(() => trackOrigin("file:///etc/passwd")).toThrow();
  });
});

describe("crawlproof actors extension", () => {
  let dir = "";
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it("mints a token for the actor and writes a private folder", async () => {
    dir = mkdtempSync(join(tmpdir(), "cp-ext-"));
    const out = join(dir, "declare");
    const calls: [string, string, unknown][] = [];
    const call = async (method: string, path: string, body?: Record<string, unknown>) => {
      calls.push([method, path, body]);
      if (method === "GET") {
        return { status: 200, json: { actors: [{ id: "a2", email: "riotcoder@profullstack.com", name: "riotcoder", kind: "agent", email_verified: true, visibility: "private", tokens: [], last30: { events: 0, pageviews: 0, contradictions: 0, sites: 0 } }] } };
      }
      return { status: 201, json: { id: "t9", token: TOKEN, prefix: "cpa_AAAA" } };
    };
    const lines: string[] = [];
    const code = await runActors(
      ["extension", "riotcoder@profullstack.com"],
      { out },
      call,
      { write: (l) => lines.push(l), error: (l) => lines.push(`ERR ${l}`) },
      { base: "https://crawlproof.com" },
    );
    expect(code).toBe(0);
    expect(calls[1]).toEqual(["POST", "/api/tracker/v1/actors/a2/tokens", { label: "browser extension" }]);
    expect(JSON.parse(readFileSync(join(out, "rules.json"), "utf8"))[0].action.requestHeaders[0].value).toBe(TOKEN);
    expect(statSync(out).mode & 0o777).toBe(0o700);
    expect(statSync(join(out, "rules.json")).mode & 0o777).toBe(0o600);
    expect(lines.join("\n")).toContain("--load-extension=");
  });

  it("asks for an actor it can find instead of guessing", async () => {
    const call = async () => ({ status: 200, json: { actors: [] } });
    const errors: string[] = [];
    expect(await runActors(["extension", "nobody@example.com"], {}, call, { write: () => {}, error: (l) => errors.push(l) })).toBe(2);
    expect(errors[0]).toContain("usage: crawlproof actors extension");
  });
});

describe("actors revoke --token-id (regression)", () => {
  it("revokes one token by id, and --token-id never becomes the API key", async () => {
    const { apiToken, parseArgs } = await import("@/packages/cli/src/cli");
    const args = parseArgs(["actors", "revoke", "riotcoder@profullstack.com", "--token-id=t9"]);
    // --token is the CLI-wide API key override; the token id must not land there.
    expect(args.flags.token).toBeUndefined();
    const prev = process.env.CRAWLPROOF_TOKEN;
    const FAKE_KEY = "crp_" + "x".repeat(40); // fixture, not a credential
    process.env.CRAWLPROOF_TOKEN = FAKE_KEY;
    expect(apiToken(args)).toBe(FAKE_KEY);
    if (prev === undefined) delete process.env.CRAWLPROOF_TOKEN;
    else process.env.CRAWLPROOF_TOKEN = prev;

    const calls: [string, string][] = [];
    const call = async (method: string, path: string) => {
      calls.push([method, path]);
      return method === "GET"
        ? { status: 200, json: { actors: [{ id: "a2", email: "riotcoder@profullstack.com", name: "", kind: "agent", email_verified: true, visibility: "private", tokens: [], last30: { events: 0, pageviews: 0, contradictions: 0, sites: 0 } }] } }
        : { status: 200, json: { ok: true } };
    };
    expect(await runActors(args.positional, args.flags, call, { write: () => {}, error: () => {} })).toBe(0);
    expect(calls[1]).toEqual(["DELETE", "/api/tracker/v1/actors/a2/tokens?token=t9"]);
  });
});
