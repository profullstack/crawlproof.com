// @vitest-environment node
import { describe, it, expect } from "vitest";
import { runWebhooks } from "@/lib/webhooks/cli";

function rig(json: Record<string, unknown> = {}, status = 200) {
  const calls: Array<[string, string, unknown]> = [];
  const out: string[] = [];
  const err: string[] = [];
  const call = async (m: "GET" | "POST" | "PATCH" | "DELETE", p: string, b?: Record<string, unknown>) => {
    calls.push([m, p, b]);
    return { status, json };
  };
  return { calls, out, err, call, io: { write: (l: string) => out.push(l), error: (l: string) => err.push(l) } };
}

describe("crawlproof webhooks", () => {
  it("create posts url, events and site, and prints the secret once", async () => {
    const r = rig({ endpoint: { id: "wh_1", url: "https://x.example/h" }, secret: ["whsec", "abc"].join("_") }, 201);
    expect(await runWebhooks(["create", "https://x.example/h"], { site: "blog.example.com", events: "com.crawlproof.post.*" }, r.call, r.io)).toBe(0);
    expect(r.calls[0]).toEqual(["POST", "/api/v1/webhooks?site=blog.example.com", { url: "https://x.example/h", events: ["com.crawlproof.post.*"] }]);
    expect(r.out.join("\n")).toContain("whsec_abc");
  });

  it("maps the other commands onto the routes", async () => {
    const r = rig({ ok: true, status: 200, deliveries: [], endpoints: [] });
    await runWebhooks(["list"], {}, r.call, r.io);
    await runWebhooks(["test", "wh_1"], {}, r.call, r.io);
    await runWebhooks(["rotate", "wh_1"], {}, r.call, r.io);
    await runWebhooks(["update", "wh_1"], { disable: true }, r.call, r.io);
    await runWebhooks(["deliveries", "wh_1"], { limit: "5" }, r.call, r.io);
    await runWebhooks(["retry", "dlv_9"], {}, r.call, r.io);
    await runWebhooks(["delete", "wh_1"], {}, r.call, r.io);
    expect(r.calls.map((c) => `${c[0]} ${c[1]}`)).toEqual([
      "GET /api/v1/webhooks",
      "POST /api/v1/webhooks/wh_1/test",
      "POST /api/v1/webhooks/wh_1/rotate",
      "PATCH /api/v1/webhooks/wh_1",
      "GET /api/v1/webhooks/wh_1/deliveries?limit=5",
      "POST /api/v1/webhooks/deliveries/dlv_9/retry",
      "DELETE /api/v1/webhooks/wh_1",
    ]);
    expect(r.calls[3][2]).toEqual({ enabled: false });
  });

  it("reports API errors", async () => {
    const r = rig({ error: "Which site? a.com, b.com" }, 400);
    expect(await runWebhooks(["list"], {}, r.call, r.io)).toBe(1);
    expect(r.err[0]).toContain("Which site?");
  });
});
