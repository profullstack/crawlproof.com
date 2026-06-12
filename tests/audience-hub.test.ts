import { describe, it, expect } from "vitest";
import { statusForEvent, AUDIENCE_BROWSER_EVENTS } from "@/lib/audience/hub";
import {
  detectStackFromPackageJson,
  envExampleBlock,
  generatedServerHelper,
  generatedClientHelper,
  serverHelperPath,
} from "@/lib/github/install-audience";

describe("statusForEvent", () => {
  it("maps lifecycle events to lifecycle statuses", () => {
    expect(statusForEvent("identify")).toBe("lead");
    expect(statusForEvent("lead.captured")).toBe("lead");
    expect(statusForEvent("newsletter.subscribed")).toBe("subscriber");
    expect(statusForEvent("user.created")).toBe("user");
    expect(statusForEvent("customer.created")).toBe("customer");
    expect(statusForEvent("payment.succeeded")).toBe("customer");
    expect(statusForEvent("plan.changed")).toBe("customer");
  });

  it("maps opt-out and deletion to terminal statuses", () => {
    expect(statusForEvent("newsletter.unsubscribed")).toBe("unsubscribed");
    expect(statusForEvent("user.deleted")).toBe("deleted");
    expect(statusForEvent("account.deleted")).toBe("deleted");
  });

  it("ignores behavioral / unknown events", () => {
    expect(statusForEvent("pageview")).toBeNull();
    expect(statusForEvent("button_click")).toBeNull();
    expect(statusForEvent("totally.custom")).toBeNull();
  });
});

describe("AUDIENCE_BROWSER_EVENTS", () => {
  it("forwards identity events but not plain pageviews", () => {
    expect(AUDIENCE_BROWSER_EVENTS.has("identify")).toBe(true);
    expect(AUDIENCE_BROWSER_EVENTS.has("consent")).toBe(true);
    expect(AUDIENCE_BROWSER_EVENTS.has("alias")).toBe(true);
    expect(AUDIENCE_BROWSER_EVENTS.has("lead.captured")).toBe(true);
    expect(AUDIENCE_BROWSER_EVENTS.has("pageview")).toBe(false);
    expect(AUDIENCE_BROWSER_EVENTS.has("scroll_50")).toBe(false);
  });
});

describe("detectStackFromPackageJson", () => {
  const pkg = (deps: Record<string, string>) =>
    JSON.stringify({ dependencies: deps });

  it("detects Next.js app vs pages router from layout hints", () => {
    expect(
      detectStackFromPackageJson(pkg({ next: "^16.0.0" }), { hasAppLayout: true }),
    ).toBe("nextjs-app");
    expect(
      detectStackFromPackageJson(pkg({ next: "^16.0.0" }), { hasPagesApp: true }),
    ).toBe("nextjs-pages");
    // App router wins when both exist (hybrid repos).
    expect(
      detectStackFromPackageJson(pkg({ next: "^16.0.0" }), {
        hasAppLayout: true,
        hasPagesApp: true,
      }),
    ).toBe("nextjs-app");
  });

  it("detects hono, express, and vite", () => {
    expect(detectStackFromPackageJson(pkg({ hono: "^4.0.0" }))).toBe("hono");
    expect(detectStackFromPackageJson(pkg({ express: "^4.18.0" }))).toBe("express");
    expect(
      detectStackFromPackageJson(JSON.stringify({ devDependencies: { vite: "^6.0.0" } })),
    ).toBe("vite");
  });

  it("next takes precedence over vite tooling in the same repo", () => {
    expect(detectStackFromPackageJson(pkg({ next: "16.0.0", vite: "6.0.0" }))).toBe(
      "nextjs-app",
    );
  });

  it("falls back to static / unknown", () => {
    expect(detectStackFromPackageJson(null, { hasIndexHtml: true })).toBe("static");
    expect(detectStackFromPackageJson(null)).toBe("unknown");
    expect(detectStackFromPackageJson("not json")).toBe("unknown");
    expect(detectStackFromPackageJson(pkg({}), { hasIndexHtml: true })).toBe("static");
  });
});

describe("serverHelperPath", () => {
  it("places the helper per stack conventions", () => {
    expect(serverHelperPath("nextjs-app")).toBe("lib/crawlproof/server.ts");
    expect(serverHelperPath("nextjs-pages")).toBe("lib/crawlproof/server.ts");
    expect(serverHelperPath("hono")).toBe("src/lib/crawlproof.ts");
    expect(serverHelperPath("express")).toBe("src/lib/crawlproof.ts");
    expect(serverHelperPath("vite")).toBeNull();
    expect(serverHelperPath("static")).toBeNull();
  });
});

describe("generated files", () => {
  it("env block documents all three variables with the project id filled", () => {
    const block = envExampleBlock("proj-123");
    expect(block).toContain("CRAWLPROOF_PROJECT_ID=proj-123");
    expect(block).toContain("CRAWLPROOF_PROJECT_KEY=");
    expect(block).toContain("CRAWLPROOF_INGEST_URL=");
    expect(block).toContain("/api/events");
  });

  it("server helper reads env, never throws, and posts the project domain", () => {
    const code = generatedServerHelper("qaaas.dev");
    expect(code).toContain("process.env.CRAWLPROOF_PROJECT_KEY");
    expect(code).toContain("process.env.CRAWLPROOF_INGEST_URL");
    expect(code).toContain('project: "qaaas.dev"');
    expect(code).toContain("sendCrawlProofEvent");
    // No secrets baked into generated code.
    expect(code).not.toContain("cpk_");
  });

  it("client helper queues calls before stats.js loads", () => {
    const code = generatedClientHelper();
    expect(code).toContain("window.crawlproof");
    expect(code).toContain("identify");
    expect(code).toContain("consent");
  });
});

describe("project ingest keys", () => {
  it("mints cpk_ keys and verifies by peppered sha256", async () => {
    const { mintProjectKey, hashProjectKey, isProjectKeyShape } = await import(
      "@/lib/audience/projectKeys"
    );
    const minted = mintProjectKey();
    expect(minted.plaintext.startsWith("cpk_")).toBe(true);
    expect(minted.prefix).toBe(minted.plaintext.slice(0, 8));
    expect(minted.hash).toBe(hashProjectKey(minted.plaintext));
    expect(minted.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(isProjectKeyShape(minted.plaintext)).toBe(true);
    expect(isProjectKeyShape("crp_not_a_project_key_aaaaaaaaaaaaaaaa")).toBe(false);
    expect(isProjectKeyShape("cpk_short")).toBe(false);
  });
});
